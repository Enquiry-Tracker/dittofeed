import { SourceType } from "isomorphic-lib/src/constants";
import { err, ok, Result, ResultAsync } from "neverthrow";
import qs from "querystring";
import { omitBy } from "remeda";
import TwilioClient from "twilio";
import RestException from "twilio/lib/base/RestException";
import { v5 as uuidv5 } from "uuid";

import { submitBatch } from "../apps/batch";
import config from "../config";
import logger from "../logger";
import {
  BatchTrackData,
  EventType,
  InternalEventType,
  MessageTags,
  SmsProviderType,
  TwilioInboundSchema,
  TwilioMessageStatus,
  TwilioWebhookRequest,
} from "../types";

export const TwilioRestException = RestException;

export interface PhoneNumberSender {
  from: string;
}

export interface MessagingServiceSender {
  messagingServiceSid: string;
}

export type Sender = PhoneNumberSender | MessagingServiceSender;

export type TwilioAuth =
  | {
      type: "authToken";
      authToken: string;
    }
  | {
      type: "apiKey";
      apiKeySid: string;
      apiKeySecret: string;
    };

export async function sendSms({
  body,
  to,
  subscriptionGroupId,
  userId,
  workspaceId,
  disableCallback = false,
  tags,
  auth,
  accountSid,
  ...sender
}: {
  body: string;
  to: string;
  subscriptionGroupId: string | undefined;
  userId: string;
  workspaceId: string;
  accountSid: string;
  auth: TwilioAuth;
  disableCallback?: boolean;
  tags?: MessageTags;
} & Sender): Promise<Result<{ sid: string }, RestException | Error>> {
  const client =
    auth.type === "apiKey"
      ? TwilioClient(auth.apiKeySid, auth.apiKeySecret, {
          accountSid,
        })
      : TwilioClient(accountSid, auth.authToken);
  try {
    let statusCallback: string | undefined;
    if (!disableCallback) {
      const baseCallbackUrl = `${config().dashboardUrl}/api/public/webhooks/twilio`;
      const queryParams = qs.stringify({
        ...omitBy(tags, (_v, key) => key === "channel"),
        subscriptionGroupId,
        userId,
        workspaceId,
      });
      statusCallback = `${baseCallbackUrl}?${queryParams}`;
    }

    const createPayload = {
      ...sender,
      body,
      to,
      statusCallback,
    };
    logger().debug(
      {
        accountSid,
        ...createPayload,
      },
      "Sending SMS",
    );
    const response = await client.messages.create(createPayload);
    logger().debug({ response }, "SMS sent");
    return ok({ sid: response.sid });
  } catch (e) {
    if (e instanceof RestException) {
      return err(e);
    }
    // unknown error
    const error = e as Error;
    return err(error);
  }
}

export async function submitTwilioEvents({
  workspaceId,
  TwilioEvent,
  userId,
  ...tags
}: {
  TwilioEvent: TwilioInboundSchema;
} & TwilioWebhookRequest): Promise<ResultAsync<void, Error>> {
  let eventName: InternalEventType;
  const body = TwilioEvent.Body;

  switch (TwilioEvent.SmsStatus) {
    case TwilioMessageStatus.Failed:
      eventName = InternalEventType.SmsFailed;
      break;
    // ET-10281: `undelivered` means Twilio accepted the message and the carrier
    // did not deliver it — handset unreachable (30003), carrier rejection or
    // filtering (30008). It is a terminal failure and was previously dropped
    // here, so those sends still read as successful in delivery history. There
    // is no SmsUndelivered internal event and adding one would ripple through
    // segments, journeys and the UI, so it maps to SmsFailed; the exact status
    // and Twilio error code are recorded in the event properties below, which
    // keeps `failed` and `undelivered` distinguishable when querying.
    case TwilioMessageStatus.Undelivered:
      eventName = InternalEventType.SmsFailed;
      break;
    case TwilioMessageStatus.Delivered:
      // TODO wrong
      eventName = InternalEventType.SmsDelivered;
      break;
    // ET-10281: intermediate lifecycle statuses are not failures. Twilio began
    // sending these on 2026-08-27 and each one was logged at error level — one
    // "error" per SMS sent, 22 of the 36 events in the window that tripped the
    // error-rate alert on 2026-09-09. Acknowledge them without writing an event.
    case TwilioMessageStatus.Queued:
    case TwilioMessageStatus.Sending:
    case TwilioMessageStatus.Sent:
    case TwilioMessageStatus.Accepted:
    case TwilioMessageStatus.Scheduled:
      logger().debug(
        {
          workspaceId,
          userId,
          smsStatus: TwilioEvent.SmsStatus,
          messageSid: TwilioEvent.MessageSid,
        },
        "Intermediate Twilio status, no event recorded",
      );
      return ok(undefined);
    default:
      logger().error(
        {
          workspaceId,
          userId,
          TwilioEvent,
        },
        "Unhandled Twilio event type",
      );
      return err(
        new Error(`Unhandled Twilio event type: ${TwilioEvent.SmsStatus}`),
      );
  }

  if (!userId) {
    return err(new Error("Missing userId."));
  }

  const messageId = uuidv5(
    `${TwilioEvent.SmsStatus}:${TwilioEvent.MessageSid}`,
    workspaceId,
  );

  const item = {
    type: EventType.Track,
    event: eventName,
    userId,
    messageId,
    properties: {
      workspaceId,
      userId,
      body,
      // ET-10281: without these, an undelivered send is indistinguishable from a
      // failed one and the carrier reason is lost. errorCode is what separates an
      // unreachable handset (30003) from carrier filtering (30008).
      smsStatus: TwilioEvent.SmsStatus,
      ...(TwilioEvent.ErrorCode !== undefined
        ? { errorCode: TwilioEvent.ErrorCode }
        : {}),
      ...tags,
    },
  } as BatchTrackData;

  return ResultAsync.fromPromise(
    submitBatch({
      workspaceId,
      data: {
        context: {
          source: SourceType.Webhook,
          provider: SmsProviderType.Twilio,
        },
        batch: [item],
      },
    }),
    (e) => (e instanceof Error ? e : Error(e as string)),
  );
}
