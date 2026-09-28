/* eslint-disable import/first */
// For tests that don't require the custom journeys implementation,
// we can keep the basic initial mock.
jest.mock("./journeys", () => ({
  triggerEventEntryJourneys: jest.fn(),
}));

import NodeCache from "node-cache";
import { v4 as uuidv4 } from "uuid";

import { submitBatch } from "./apps/batch";
import { db } from "./db";
import { journey as dbJourney } from "./db/schema";
import {
  EventType,
  JourneyDefinition,
  JourneyInsert,
  JourneyNodeType,
} from "./types";
import { findManyEventsWithCount } from "./userEvents";
import { createWorkspace } from "./workspaces";

jest.setTimeout(30000);

describe("apps", () => {
  let workspaceId: string;

  beforeEach(async () => {
    workspaceId = uuidv4();
    await createWorkspace({
      id: workspaceId,
      name: `test-${workspaceId}`,
    });
  });

  describe("submitBatch", () => {
    describe("when events don't have traits or properties", () => {
      it("should default traits or properties to empty object", async () => {
        await submitBatch({
          workspaceId,
          data: {
            batch: [
              {
                type: EventType.Identify,
                messageId: uuidv4(),
                userId: uuidv4(),
              },
              {
                type: EventType.Track,
                event: "Purchase",
                messageId: uuidv4(),
                userId: uuidv4(),
              },
            ],
          },
        });
        const { events } = await findManyEventsWithCount({
          workspaceId,
        });
        expect(events.map((er) => er.properties)).toEqual(["{}", "{}"]);
      });
    });
  });
  describe("submitBatchWithTriggers", () => {
    let startKeyedJourneyImpl: jest.Mock;
    let notStartedJourneyId: string;
    let startedEventTriggeredJourneyId: string;
    let segmentEntryJourneyId: string;
    let entryEventName: string;
    let journeyCache: NodeCache;
    let journeyCacheDel: jest.SpyInstance;
    let submitBatchWithTriggers: typeof import("./apps").submitBatchWithTriggers;

    beforeEach(async () => {
      // Reset module registry so that our new mock is picked up.
      jest.resetModules();

      entryEventName = "Purchase";
      const eventTriggeredJourneyDefinition: JourneyDefinition = {
        entryNode: {
          type: JourneyNodeType.EventEntryNode,
          event: entryEventName,
          child: JourneyNodeType.ExitNode,
          key: "itemId",
        },
        nodes: [],
        exitNode: {
          type: JourneyNodeType.ExitNode,
        },
      };
      const segmentEntryJourneyDefinition: JourneyDefinition = {
        entryNode: {
          type: JourneyNodeType.SegmentEntryNode,
          segment: "test-segment",
          child: JourneyNodeType.ExitNode,
        },
        nodes: [],
        exitNode: {
          type: JourneyNodeType.ExitNode,
        },
      };
      segmentEntryJourneyId = uuidv4();
      notStartedJourneyId = uuidv4();
      startedEventTriggeredJourneyId = uuidv4();

      await db()
        .insert(dbJourney)
        .values([
          {
            id: notStartedJourneyId,
            name: "not started",
            status: "NotStarted",
            workspaceId,
            definition: eventTriggeredJourneyDefinition,
          } satisfies JourneyInsert,
          {
            id: startedEventTriggeredJourneyId,
            name: "started event triggered",
            status: "Running",
            workspaceId,
            definition: eventTriggeredJourneyDefinition,
          },
          {
            id: segmentEntryJourneyId,
            name: "segment entry",
            status: "Running",
            workspaceId,
            definition: segmentEntryJourneyDefinition,
          },
        ]);

      startKeyedJourneyImpl = jest.fn();

      // Import the actual implementation from the unmocked module. Typed, so the
      // factory call below is checked rather than `any`.
      //
      // The cache is built from the PRODUCTION options on purpose: useClones
      // defaults to true, and under it a cached promise is deep-cloned into a
      // second promise nobody awaits — a failed load then rejects unhandled and
      // Node 20 exits. A cache built with NodeCache's defaults would not exercise
      // what ships.
      const {
        triggerEventEntryJourneysFactory,
        EVENT_TRIGGER_JOURNEY_CACHE_OPTIONS,
      } = jest.requireActual<typeof import("./journeys")>("./journeys");
      journeyCache = new NodeCache(EVENT_TRIGGER_JOURNEY_CACHE_OPTIONS);
      // Held as a variable rather than asserted via journeyCache.del — referencing
      // the method unbound trips @typescript-eslint/unbound-method.
      journeyCacheDel = jest.spyOn(journeyCache, "del");

      // Re-mock the journeys module with our custom implementation.
      jest.doMock("./journeys", () => ({
        triggerEventEntryJourneys: triggerEventEntryJourneysFactory({
          journeyCache,
          startKeyedJourneyImpl,
        }),
      }));

      // Re-import the apps module so that it picks up our new journeys mock.
      const apps = await import("./apps");
      submitBatchWithTriggers = apps.submitBatchWithTriggers;
    });

    it("it should trigger journeys for users with matching events", async () => {
      const userId1 = uuidv4();
      const userId2 = uuidv4();

      await submitBatchWithTriggers({
        workspaceId,
        data: {
          batch: [
            {
              type: EventType.Track,
              event: entryEventName,
              messageId: uuidv4(),
              userId: userId1,
              properties: { amount: 100, itemId: "123" },
            },
            {
              type: EventType.Track,
              event: "missing-event",
              messageId: uuidv4(),
              userId: userId1,
            },
            {
              type: EventType.Identify,
              messageId: uuidv4(),
              userId: userId2,
              traits: { name: "Test User" },
            },
          ],
        },
      });
      expect(startKeyedJourneyImpl).toHaveBeenCalledTimes(1);
      expect(startKeyedJourneyImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          journeyId: startedEventTriggeredJourneyId,
          userId: userId1,
        }),
      );
    });

    // ET-10394. submitBatchWithTriggers fires triggerEventEntryJourneys once per
    // Track message via Promise.all. The cache used to store the resolved value and
    // only after the load finished, so concurrent events all missed and each ran a
    // full load. On a workspace with 44,286 journeys that was 3.3s of blocking CPU
    // per event — a batch this size froze the pod until liveness killed it.
    // Counting findMany is the direct measure: one load for three concurrent
    // triggers. Before the fix it was three.
    it("loads a workspace's journeys once per batch, not once per event", async () => {
      const userId = uuidv4();
      const dbModule = await import("./db");
      const findMany = jest.spyOn(dbModule.db().query.journey, "findMany");

      try {
        await submitBatchWithTriggers({
          workspaceId,
          data: {
            batch: [1, 2, 3].map(() => ({
              type: EventType.Track,
              event: entryEventName,
              messageId: uuidv4(),
              userId,
              properties: { amount: 100, itemId: "123" },
            })),
          },
        });

        // The direct measure: three concurrent triggers, one load. Before the fix
        // this was three.
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(startKeyedJourneyImpl).toHaveBeenCalledTimes(3);

        // And a SECOND batch inside the TTL must be served from cache. This is the
        // property that matters and the one nothing covered: an earlier revision
        // stamped the TTL at store time instead of resolve, so the entry expired
        // before it ever served a hit — the cache never populated and every test
        // above still passed.
        await submitBatchWithTriggers({
          workspaceId,
          data: {
            batch: [
              {
                type: EventType.Track,
                event: entryEventName,
                messageId: uuidv4(),
                userId,
                properties: { amount: 100, itemId: "123" },
              },
            ],
          },
        });
        expect(findMany).toHaveBeenCalledTimes(1);
      } finally {
        findMany.mockRestore();
      }
    });

    // A rejected load must not stay in the cache. Without the catch that evicts it,
    // one failed query would be handed to every caller of that workspace for the
    // whole 30s TTL — a worse outage than the one this change fixes.
    it("does not leave a failed load in the cache", async () => {
      const dbModule = await import("./db");
      const findMany = jest
        .spyOn(dbModule.db().query.journey, "findMany")
        .mockRejectedValueOnce(new Error("load failed"));

      const oneTrackEvent = () => ({
        workspaceId,
        data: {
          batch: [
            {
              type: EventType.Track as const,
              event: entryEventName,
              messageId: uuidv4(),
              userId: uuidv4(),
              properties: { amount: 100, itemId: "123" },
            },
          ],
        },
      });

      try {
        await expect(submitBatchWithTriggers(oneTrackEvent())).rejects.toThrow(
          "load failed",
        );
        expect(journeyCacheDel).toHaveBeenCalledWith(workspaceId);
        expect(journeyCache.get(workspaceId)).toBeUndefined();
      } finally {
        findMany.mockRestore();
      }

      // The next caller retries instead of being handed the cached rejection.
      // toBeDefined() would not prove that: the cache holds a promise written
      // before the await, so a REJECTED one is "defined" too. Resolve it instead —
      // beforeEach inserts exactly one Running EventEntryNode journey.
      await submitBatchWithTriggers(oneTrackEvent());
      await expect(
        journeyCache.get<Promise<unknown[]>>(workspaceId),
      ).resolves.toHaveLength(1);
    });
  });
});
