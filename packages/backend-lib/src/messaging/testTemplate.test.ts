import axios, { AxiosResponse } from "axios";
import { randomUUID } from "crypto";
import { SecretNames } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  ChannelType,
  EmailProviderType,
  EmailTemplateResource,
  InternalEventType,
  JsonResultType,
  MessageTemplateTestRequest,
  MessageTemplateTestResponse,
  ParsedWebhookBody,
  SubscriptionGroupType,
  WebhookTemplateResource,
} from "isomorphic-lib/src/types";

import { insert } from "../db";
import { secret as dbSecret, workspace as dbWorkspace } from "../db/schema";
import logger from "../logger";
import { testTemplate, upsertMessageTemplate } from "../messaging";
import { upsertEmailProvider } from "../messaging/email";
import {
  upsertSubscriptionGroup,
  upsertSubscriptionSecret,
} from "../subscriptionGroups";
import { Workspace } from "../types";

jest.mock("axios");

const { AxiosHeaders } = jest.requireActual<typeof import("axios")>("axios");

const mockAxios = axios as jest.Mocked<typeof axios>;

describe("testTemplate", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    jest.clearAllMocks();

    workspace = unwrap(
      await insert({
        table: dbWorkspace,
        values: {
          id: randomUUID(),
          name: `workspace-${randomUUID()}`,
          updatedAt: new Date(),
          createdAt: new Date(),
        },
      }),
    );
  });

  it("should reproduce schema validation error with webhook response", async () => {
    // Mock webhook response with empty body that causes schema validation issues
    const headers = AxiosHeaders.from({ "content-type": "application/json" });
    const mockResponse: AxiosResponse = {
      data: "", // Empty string body that might cause schema validation issues
      status: 201,
      statusText: "Created",
      headers,
      config: {
        headers,
      },
    };

    mockAxios.request.mockResolvedValue(mockResponse);

    // Create webhook secret
    await insert({
      table: dbSecret,
      values: {
        id: randomUUID(),
        workspaceId: workspace.id,
        name: SecretNames.Webhook,
        configValue: {
          type: ChannelType.Webhook,
          ApiKey: "test-key",
        },
      },
    });

    // Create webhook template
    const template = unwrap(
      await upsertMessageTemplate({
        name: randomUUID(),
        workspaceId: workspace.id,
        definition: {
          type: ChannelType.Webhook,
          identifierKey: "id",
          body: JSON.stringify({
            config: {
              url: "https://example.com/webhook",
              method: "POST",
              responseType: "json",
              data: {
                message: "test message",
              },
            },
          } satisfies ParsedWebhookBody),
        } satisfies WebhookTemplateResource,
      }),
    );

    const testRequest: MessageTemplateTestRequest = {
      workspaceId: workspace.id,
      templateId: template.id,
      channel: ChannelType.Webhook,
      userProperties: { id: "test-user" },
    };

    const result = await testTemplate(testRequest);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Test that the response can be validated against the MessageTemplateTestResponse schema
      const response = {
        type: JsonResultType.Ok,
        value: result.value,
      };

      const validationResult = schemaValidateWithErr(
        response,
        MessageTemplateTestResponse,
      );
      if (validationResult.isErr()) {
        logger().error({ err: validationResult.error }, "Schema validation");
        throw new Error("Schema validation error");
      }

      // For now just verify the structure is as expected
      expect(result.value.type).toBe(InternalEventType.MessageSent);
    }
  });

  it("should handle array headers with undefined body", async () => {
    const headers = AxiosHeaders.from({
      "content-type": ["text/plain", "application/json"],
    });

    const mockResponse: AxiosResponse = {
      data: undefined,
      status: 201,
      statusText: "Created",
      headers,
      config: {
        headers,
      },
    };

    mockAxios.request.mockResolvedValue(mockResponse);

    // Create webhook secret
    await insert({
      table: dbSecret,
      values: {
        id: randomUUID(),
        workspaceId: workspace.id,
        name: SecretNames.Webhook,
        configValue: {
          type: ChannelType.Webhook,
          ApiKey: "test-key",
        },
      },
    });

    // Create webhook template
    const template = unwrap(
      await upsertMessageTemplate({
        name: randomUUID(),
        workspaceId: workspace.id,
        definition: {
          type: ChannelType.Webhook,
          identifierKey: "id",
          body: JSON.stringify({
            config: {
              url: "https://example.com/webhook",
              method: "POST",
              responseType: "text",
              data: {
                message: "test message",
              },
            },
          } satisfies ParsedWebhookBody),
        } satisfies WebhookTemplateResource,
      }),
    );

    const testRequest: MessageTemplateTestRequest = {
      workspaceId: workspace.id,
      templateId: template.id,
      channel: ChannelType.Webhook,
      userProperties: { id: "test-user" },
    };

    const result = await testTemplate(testRequest);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Test schema validation
      const response = {
        type: JsonResultType.Ok,
        value: result.value,
      };

      const validationResult = schemaValidateWithErr(
        response,
        MessageTemplateTestResponse,
      );
      if (validationResult.isErr()) {
        logger().error({ err: validationResult.error }, "Schema validation");
        throw new Error("Schema validation error");
      }

      expect(result.value.type).toBe(InternalEventType.MessageSent);
    }
  });

  describe("email test sends are transactional (no List-* bulk headers)", () => {
    async function setupEmail() {
      const template = unwrap(
        await upsertMessageTemplate({
          name: randomUUID(),
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello",
            body: "Hello.",
          } satisfies EmailTemplateResource,
        }),
      );
      // testTemplate auto-attaches the FIRST subscription group for the
      // workspace+channel. Even so, because it sends with isPreview, the
      // List-* bulk headers must be suppressed (test/preview sends are
      // transactional, e.g. one-time passcodes).
      await Promise.all([
        upsertEmailProvider({
          workspaceId: workspace.id,
          config: { type: EmailProviderType.Test },
        }),
        upsertSubscriptionGroup({
          workspaceId: workspace.id,
          name: `group-${randomUUID()}`,
          type: SubscriptionGroupType.OptOut,
          channel: ChannelType.Email,
        }).then(unwrap),
        upsertSubscriptionSecret({ workspaceId: workspace.id }),
      ]);
      return template;
    }

    it("omits the List-* bulk headers even with a subscription group present", async () => {
      const template = await setupEmail();
      const request: MessageTemplateTestRequest = {
        workspaceId: workspace.id,
        templateId: template.id,
        channel: ChannelType.Email,
        provider: EmailProviderType.Test,
        userProperties: { id: "test-user", email: "test@email.com" },
      };
      const result = unwrap(await testTemplate(request));
      if (
        result.type !== InternalEventType.MessageSent ||
        result.variant.type !== ChannelType.Email
      ) {
        throw new Error("Expected email message sent");
      }
      expect(result.variant.headers?.["List-Unsubscribe"]).toBeUndefined();
      expect(result.variant.headers?.["List-Unsubscribe-Post"]).toBeUndefined();
      expect(result.variant.headers?.["List-ID"]).toBeUndefined();
    });
  });
});
