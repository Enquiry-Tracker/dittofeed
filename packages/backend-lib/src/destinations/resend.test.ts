import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { EventType } from "isomorphic-lib/src/types";

import { InternalEventType, ResendEvent, ResendEventType } from "../types";
import { resendEventToDF } from "./resend";

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

/**
 * ET-9318. The converter read `data.created_at` — when the EMAIL was created, identical across
 * every webhook for it — instead of the envelope's `created_at`, when the EVENT happened. That
 * collapsed delivered/opened/clicked onto one event_time; deliveries.ts explains what it broke.
 */
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

    // Narrow once; the throw is itself the assertion that both are set.
    const { timestamp: deliveredAt } = delivered;
    const { timestamp: openedAt } = opened;
    if (!deliveredAt || !openedAt) {
      throw new Error("expected both events to carry a timestamp");
    }

    expect(openedAt).not.toBe(deliveredAt);
    expect(new Date(openedAt).getTime()).toBeGreaterThan(
      new Date(deliveredAt).getTime(),
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
