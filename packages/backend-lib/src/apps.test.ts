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

      // Import the actual triggerEventEntryJourneysFactory from the unmocked module.
      const { triggerEventEntryJourneysFactory } =
        jest.requireActual("./journeys");

      // Held in scope (and spied) so the stampede test can count how many times a
      // whole batch loads the workspace's journeys — see ET-10394.
      journeyCache = new NodeCache();
      jest.spyOn(journeyCache, "set");
      jest.spyOn(journeyCache, "del");

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
    // One cache write proves one load was shared; three would mean the stampede.
    it("loads a workspace's journeys once per batch, not once per event", async () => {
      const userId = uuidv4();

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

      expect(journeyCache.set).toHaveBeenCalledTimes(1);
      expect(startKeyedJourneyImpl).toHaveBeenCalledTimes(3);
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

      await expect(submitBatchWithTriggers(oneTrackEvent())).rejects.toThrow(
        "load failed",
      );
      expect(journeyCache.del).toHaveBeenCalledWith(workspaceId);
      expect(journeyCache.get(workspaceId)).toBeUndefined();

      // The next caller retries instead of being handed the cached rejection.
      findMany.mockRestore();
      await submitBatchWithTriggers(oneTrackEvent());
      expect(journeyCache.get(workspaceId)).toBeDefined();
    });
  });
});
