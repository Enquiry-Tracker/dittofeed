import { InternalEventType } from "isomorphic-lib/src/types";

import { TwilioInboundSchema, TwilioMessageStatus } from "../types";
import { submitTwilioEvents } from "./twilio";

interface RecordedItem {
  event: InternalEventType;
  properties: Record<string, unknown>;
}

interface BatchSubmission {
  data: { batch: RecordedItem[] };
}

const mockSubmitBatch = jest.fn<Promise<void>, [BatchSubmission]>();

jest.mock("../apps/batch", () => ({
  submitBatch: (submission: BatchSubmission) => mockSubmitBatch(submission),
}));

const baseEvent = {
  SmsSid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  MessageSid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  MessagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ApiVersion: "2010-04-01",
  From: "+61491570156",
  To: "+61491570157",
};

function call(TwilioEvent: TwilioInboundSchema) {
  return submitTwilioEvents({
    workspaceId: "00000000-0000-4000-8000-000000000000",
    userId: "1",
    TwilioEvent,
  });
}

function recordedItem(): RecordedItem {
  const submission = mockSubmitBatch.mock.calls[0]?.[0];
  if (!submission) {
    throw new Error("submitBatch was not called");
  }
  const item = submission.data.batch[0];
  if (!item) {
    throw new Error("submitBatch was called with an empty batch");
  }
  return item;
}

describe("submitTwilioEvents (ET-10281)", () => {
  beforeEach(() => {
    mockSubmitBatch.mockReset();
    mockSubmitBatch.mockResolvedValue(undefined);
  });

  describe("undelivered — the carrier did not deliver a message Twilio accepted", () => {
    it("records a terminal failure instead of dropping the callback", async () => {
      const result = await call({
        ...baseEvent,
        SmsStatus: TwilioMessageStatus.Undelivered,
        ErrorCode: "30003",
      });

      expect(result.isErr()).toBe(false);
      expect(mockSubmitBatch).toHaveBeenCalledTimes(1);
      expect(recordedItem().event).toBe(InternalEventType.SmsFailed);
    });

    it("keeps the status and carrier error code, so it stays distinguishable from a plain failure", async () => {
      await call({
        ...baseEvent,
        SmsStatus: TwilioMessageStatus.Undelivered,
        ErrorCode: "30008",
      });

      expect(recordedItem().properties).toMatchObject({
        smsStatus: TwilioMessageStatus.Undelivered,
        errorCode: "30008",
      });
    });

    it("omits errorCode when Twilio sends none", async () => {
      await call({ ...baseEvent, SmsStatus: TwilioMessageStatus.Undelivered });

      expect(recordedItem().properties).not.toHaveProperty("errorCode");
    });
  });

  describe("intermediate lifecycle statuses", () => {
    // Twilio began posting these on 2026-08-27; each was logged at error level,
    // one per SMS sent, which is what tripped the error-rate alert on 2026-09-09.
    it.each([
      TwilioMessageStatus.Queued,
      TwilioMessageStatus.Sending,
      TwilioMessageStatus.Sent,
      TwilioMessageStatus.Accepted,
      TwilioMessageStatus.Scheduled,
    ])("acknowledges %s without recording an event", async (SmsStatus) => {
      const result = await call({ ...baseEvent, SmsStatus });

      expect(result.isErr()).toBe(false);
      expect(mockSubmitBatch).not.toHaveBeenCalled();
    });
  });

  describe("statuses that were already handled", () => {
    it("records delivered", async () => {
      await call({ ...baseEvent, SmsStatus: TwilioMessageStatus.Delivered });

      expect(recordedItem().event).toBe(InternalEventType.SmsDelivered);
    });

    it("records failed", async () => {
      await call({ ...baseEvent, SmsStatus: TwilioMessageStatus.Failed });

      expect(recordedItem().event).toBe(InternalEventType.SmsFailed);
    });
  });

  it("still errors on an unmodelled status, so a new one stays visible", async () => {
    const result = await call({
      ...baseEvent,
      SmsStatus: TwilioMessageStatus.Canceled,
    });

    expect(result.isErr()).toBe(true);
    expect(mockSubmitBatch).not.toHaveBeenCalled();
  });
});
