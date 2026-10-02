import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { EventType } from "isomorphic-lib/src/types";

import { InternalEventType, ResendEvent, ResendEventType } from "../types";
import { resendEventToDF } from "./resend";

/**
 * ET-9318. Every Resend webhook for one email carried the SAME timestamp, because the
 * converter read `data.created_at` — when the EMAIL was created — rather than the envelope's
 * `created_at`, which is when the EVENT happened. Delivered, opened and clicked therefore
 * landed in ClickHouse with identical `event_time`.
 *
 * That is not cosmetic: the deliveries panel derives a message's status with
 * `argMax(event, event_time)`, so identical timestamps make it a tie that ClickHouse resolves
 * arbitrarily — in practice always to Delivered. Measured on prod before the fix, 10,630 of
 * 10,630 opens in seven days collided with their own Delivered, so no message ever displayed
 * "Opened" or "Clicked".
 */
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000000";

/** Envelope time and email-creation time deliberately differ — that difference is the bug. */
function event(type: ResendEventType, eventTime: string): ResendEvent {
  return {
    created_at: eventTime,
    type,
    data: {
      created_at: "2026-09-28T07:57:38.000Z",
      email_id: "11111111-2222-3333-4444-555555555555",
      from: "noreply@example.org",
      subject: "Subject",
      to: ["someone@example.org"],
      tags: { workspaceId: WORKSPACE_ID, userId: "1" },
    },
  };
}

describe("resendEventToDF timestamps (ET-9318)", () => {
  it("stamps an open with the moment it was opened, not the moment the email was created", () => {
    const item = unwrap(
      resendEventToDF({
        workspaceId: WORKSPACE_ID,
        resendEvent: event(ResendEventType.Opened, "2026-09-28T08:09:20.702Z"),
      }),
    );

    expect(item.timestamp).toBe("2026-09-28T08:09:20.702Z");
  });

  // The collision is what actually broke the panel, so assert the two are distinguishable
  // rather than only that one of them is right.
  it("gives delivered and opened different timestamps for the same email", () => {
    const delivered = unwrap(
      resendEventToDF({
        workspaceId: WORKSPACE_ID,
        resendEvent: event(
          ResendEventType.Delivered,
          "2026-09-28T07:57:40.921Z",
        ),
      }),
    );
    const opened = unwrap(
      resendEventToDF({
        workspaceId: WORKSPACE_ID,
        resendEvent: event(ResendEventType.Opened, "2026-09-28T08:09:20.702Z"),
      }),
    );

    expect(delivered.timestamp).toBeDefined();
    expect(opened.timestamp).toBeDefined();
    expect(opened.timestamp).not.toBe(delivered.timestamp);
    expect(new Date(String(opened.timestamp)).getTime()).toBeGreaterThan(
      new Date(String(delivered.timestamp)).getTime(),
    );
  });

  it("still converts the event type", () => {
    const item = unwrap(
      resendEventToDF({
        workspaceId: WORKSPACE_ID,
        resendEvent: event(ResendEventType.Clicked, "2026-09-28T08:10:00.000Z"),
      }),
    );

    // BatchItem is a union; narrowing is also the assertion that this is a track event.
    if (item.type !== EventType.Track)
      throw new Error(`expected a track event, got ${item.type}`);
    expect(item.event).toBe(InternalEventType.EmailClicked);
  });
});
