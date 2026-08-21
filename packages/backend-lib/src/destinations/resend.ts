import { SourceType } from "isomorphic-lib/src/constants";
import { err, ok, Result, ResultAsync } from "neverthrow";
import * as R from "remeda";
import { ErrorResponse, Resend } from "resend";
import { v5 as uuidv5 } from "uuid";

import { submitBatch } from "../apps/batch";
import { MESSAGE_METADATA_FIELDS } from "../constants";
import logger from "../logger";
import {
  BatchAppData,
  BatchItem,
  BatchTrackData,
  EmailProviderType,
  EventType,
  InternalEventType,
  ResendEvent,
  ResendEventType,
} from "../types";

function guardResponseError(payload: unknown): ErrorResponse {
  const error = payload as Error;
  return {
    message: error.message,
    name: error.cause as ErrorResponse["name"],
  };
}

export type ResendRequiredData = Parameters<Resend["emails"]["send"]>["0"];
export type ResendResponse = Awaited<ReturnType<Resend["emails"]["send"]>>;

/**
 * Resend error codes describing a transient condition rather than a bad
 * request: the same payload sent a moment later can succeed.
 *
 * `rate_limit_exceeded` is the one that matters in practice. Resend caps an
 * account at 10 requests/second and a campaign burst blows past that in a
 * fraction of a second — one school's send produced 156 rejections in 14
 * seconds. Without a retry those messages are never delivered at all.
 */
const RETRYABLE_ERROR_NAMES = new Set<ErrorResponse["name"]>([
  "rate_limit_exceeded",
  "application_error",
  "internal_server_error",
]);

export function isRetryableResendError(name: ErrorResponse["name"]): boolean {
  return RETRYABLE_ERROR_NAMES.has(name);
}

export const MAX_SEND_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;

/**
 * Full jitter, not a fixed backoff: parallel sends hit an account-wide rate
 * limit at the same instant, so a deterministic delay only lines them up to
 * collide again on every subsequent attempt.
 */
function retryDelayMs(attempt: number): number {
  return Math.random() * RETRY_BASE_DELAY_MS * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/*
 Resend's client does not throw an error and instead returns a nullish error
 object that's why we wrap it out in our wrapper function
 */
const sendMailWrapper = async (
  apiKey: string,
  mailData: ResendRequiredData,
) => {
  const resend = new Resend(apiKey);

  // Retries live here rather than being delegated to the Temporal activity that
  // wraps this call. Letting the error escape would fail the activity, and a
  // failed activity records no `DFMessageFailure` event — the very signal
  // monitoring counts to notice that sending is unhealthy. Retrying in place
  // keeps that contract: a transient blip is absorbed, a sustained one still
  // surfaces as a message failure carrying the provider's own error.
  for (let attempt = 0; ; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const response = await resend.emails.send(mailData);
    if (!response.error) {
      return response;
    }
    const { name, message } = response.error;
    const lastAttempt = attempt >= MAX_SEND_ATTEMPTS - 1;
    if (!isRetryableResendError(name) || lastAttempt) {
      throw new Error(message, { cause: name });
    }
    const delay = retryDelayMs(attempt);
    logger().info(
      { name, message, attempt: attempt + 1, delay },
      "retrying resend send after transient provider error",
    );
    // eslint-disable-next-line no-await-in-loop
    await sleep(delay);
  }
};

export async function sendMail({
  apiKey,
  mailData,
}: {
  apiKey: string;
  mailData: ResendRequiredData;
}): Promise<ResultAsync<ResendResponse, ErrorResponse>> {
  return ResultAsync.fromPromise(
    sendMailWrapper(apiKey, mailData),
    guardResponseError,
  ).map((resultArray) => resultArray);
}

export function resendEventToDF({
  workspaceId,
  resendEvent,
}: {
  workspaceId: string;
  resendEvent: ResendEvent;
}): Result<BatchItem, Error> {
  const { type: event } = resendEvent;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { created_at, email_id, to } = resendEvent.data;

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const email = to[0]!;

  const { userId } = resendEvent.data.tags;
  if (!userId) {
    return err(new Error("Missing userId or anonymousId."));
  }
  const messageId = uuidv5(`${event}:${email_id}`, workspaceId);

  let eventName: InternalEventType;

  switch (event) {
    case ResendEventType.Opened:
      eventName = InternalEventType.EmailOpened;
      break;
    case ResendEventType.Clicked:
      eventName = InternalEventType.EmailClicked;
      break;
    case ResendEventType.Bounced:
      eventName = InternalEventType.EmailBounced;
      break;
    case ResendEventType.DeliveryDelayed:
      eventName = InternalEventType.EmailDropped;
      break;
    case ResendEventType.Complained:
      eventName = InternalEventType.EmailMarkedSpam;
      break;
    case ResendEventType.Delivered:
      eventName = InternalEventType.EmailDelivered;
      break;
    default:
      return err(new Error(`Unhandled event type: ${event}`));
  }

  const timestamp = new Date(created_at).toISOString();
  const properties: Record<string, string> = R.merge(
    { email },
    R.pick(resendEvent.data.tags, MESSAGE_METADATA_FIELDS),
  );
  let item: BatchTrackData;
  if (userId) {
    item = {
      type: EventType.Track,
      event: eventName,
      userId,
      messageId,
      timestamp,
      properties,
    };
  } else {
    return err(new Error("Missing userId and anonymousId."));
  }

  return ok(item);
}

export async function submitResendEvents({
  workspaceId,
  events,
}: {
  workspaceId: string;
  events: ResendEvent[];
}) {
  const data: BatchAppData = {
    context: {
      source: SourceType.Webhook,
      provider: EmailProviderType.Resend,
    },
    batch: events.flatMap((e) =>
      resendEventToDF({ workspaceId, resendEvent: e })
        .mapErr((error) => {
          logger().error(
            { err: error },
            "Failed to convert resend event to DF.",
          );
          return error;
        })
        .unwrapOr([]),
    ),
  };
  await submitBatch({
    workspaceId,
    data,
  });
}
