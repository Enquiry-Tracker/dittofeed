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

      // Re-mock the journeys module with our custom implementation.
      jest.doMock("./journeys", () => ({
        triggerEventEntryJourneys: triggerEventEntryJourneysFactory({
          journeyCache: new NodeCache(),
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

    // ET-10394. Every Track message of a batch triggers event-entry journeys concurrently. The
    // journey cache is only written once a load finishes, so firing them all at once made
    // every event miss and run its own full load of the workspace's journeys.
    it("loads a workspace's journeys once per batch, not once per event", async () => {
      const userId = uuidv4();
      const dbModule = await import("./db");
      const findMany = jest.spyOn(dbModule.db().query.journey, "findMany");
      const track = () => ({
        type: EventType.Track as const,
        event: entryEventName,
        messageId: uuidv4(),
        userId,
        properties: { amount: 100, itemId: "123" },
      });

      try {
        await submitBatchWithTriggers({
          workspaceId,
          data: { batch: [track(), track(), track()] },
        });
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(startKeyedJourneyImpl).toHaveBeenCalledTimes(3);
      } finally {
        findMany.mockRestore();
      }
    });

    // Warming the cache must not change error semantics: if the first event's journey start
    // fails, the rest of the batch is still attempted (as with a plain Promise.all) and the
    // batch still reports the failure. Guards the warm-up step, not the stampede: it passes
    // on base too, and fails if the first trigger's error is allowed to skip the rest.
    it("still starts the rest of the batch when the first event's start fails", async () => {
      startKeyedJourneyImpl.mockRejectedValueOnce(new Error("temporal down"));
      const track = () => ({
        type: EventType.Track as const,
        event: entryEventName,
        messageId: uuidv4(),
        userId: uuidv4(),
        properties: { amount: 100, itemId: "123" },
      });

      await expect(
        submitBatchWithTriggers({
          workspaceId,
          data: { batch: [track(), track(), track()] },
        }),
      ).rejects.toThrow("temporal down");
      expect(startKeyedJourneyImpl).toHaveBeenCalledTimes(3);
    });
  });
});
