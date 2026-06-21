/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        { messageId: string },
        boolean,
        Name
      >;
      cleanupAbandonedMessages: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        null,
        Name
      >;
      cleanupOldEvents: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        null,
        Name
      >;
      cleanupOldMessages: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        null,
        Name
      >;
      enqueueMessage: FunctionReference<
        "mutation",
        "internal",
        {
          message: {
            attachments?: Array<{
              content: string;
              contentId?: string;
              disposition?: "attachment" | "inline";
              filename: string;
              isRelated?: boolean;
            }>;
            bat?: boolean;
            bcc?: Array<{ email: string; name?: string }>;
            bulk: boolean;
            campaignId?: string;
            campaignTags?: Array<string>;
            campaignType?: string;
            cc?: Array<{ email: string; name?: string }>;
            channel: "email" | "sms";
            compressStyle?: boolean;
            dryRun?: boolean;
            emailRecipients?: Array<{
              email: string;
              name?: string;
              variables?: Record<string, string | number | boolean>;
            }>;
            expires?: string;
            forceInlineStyle?: boolean;
            from?: { email: string; name?: string };
            headers?: Record<string, string>;
            html?: string;
            listUnsub?: { method?: "mailto" | "one-click"; value: string };
            replyTo?: { email: string; name?: string };
            senderId?: string;
            shortenUrls?: boolean;
            shortenWithProtocol?: boolean;
            smsRecipients?: Array<{ num: string; region: string }>;
            subject?: string;
            templateId?: string;
            text?: string;
            variables?: Record<string, string | number | boolean>;
          };
          options: {
            apiKey: string;
            initialBackoffMs: number;
            onEvent?: { fnHandle: string };
            provider: string;
            retryAttempts: number;
            testMode: boolean;
          };
        },
        string,
        Name
      >;
      estimateSms: FunctionReference<
        "action",
        "internal",
        { apiKey: string; body: any },
        any,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { messageId: string },
        null | {
          _creationTime: number;
          _id: string;
          attachments?: Array<{
            content: string;
            contentId?: string;
            disposition?: "attachment" | "inline";
            filename: string;
            isRelated?: boolean;
          }>;
          bat?: boolean;
          bcc?: Array<{ email: string; name?: string }>;
          bulk: boolean;
          campaignId?: string;
          campaignTags?: Array<string>;
          campaignType?: string;
          cc?: Array<{ email: string; name?: string }>;
          channel: "email" | "sms";
          compressStyle?: boolean;
          creditLeft?: string;
          deliveries: Array<{
            bounced: boolean;
            channel: "email" | "sms";
            clicked: boolean;
            complained: boolean;
            delivered: boolean;
            errorMessage: string | null;
            lastEventType: string | null;
            opened: boolean;
            recipientKey: string;
            softBounced: boolean;
            status:
              | "pending"
              | "sent"
              | "delivered"
              | "soft_bounced"
              | "bounced"
              | "undelivered"
              | "stopped";
            stopped: boolean;
            swgUid: string;
            unsubscribed: boolean;
          }>;
          dryRun?: boolean;
          emailRecipients?: Array<{
            email: string;
            name?: string;
            variables?: Record<string, string | number | boolean>;
          }>;
          errorMessage?: string;
          expires?: string;
          finalizedAt: number;
          forceInlineStyle?: boolean;
          from?: { email: string; name?: string };
          headers?: Record<string, string>;
          html?: string;
          listUnsub?: { method?: "mailto" | "one-click"; value: string };
          provider: string;
          replyTo?: { email: string; name?: string };
          senderId?: string;
          shortenUrls?: boolean;
          shortenWithProtocol?: boolean;
          smsRecipients?: Array<{ num: string; region: string }>;
          status: "queued" | "sent" | "failed" | "cancelled";
          subject?: string;
          templateId?: string;
          text?: string;
          transactionId?: string;
          variables?: Record<string, string | number | boolean>;
        },
        Name
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { messageId: string },
        null | {
          channel: "email" | "sms";
          creditLeft: string | null;
          deliveries: Array<{
            bounced: boolean;
            channel: "email" | "sms";
            clicked: boolean;
            complained: boolean;
            delivered: boolean;
            errorMessage: string | null;
            lastEventType: string | null;
            opened: boolean;
            recipientKey: string;
            softBounced: boolean;
            status:
              | "pending"
              | "sent"
              | "delivered"
              | "soft_bounced"
              | "bounced"
              | "undelivered"
              | "stopped";
            stopped: boolean;
            swgUid: string;
            unsubscribed: boolean;
          }>;
          errorMessage: string | null;
          status: "queued" | "sent" | "failed" | "cancelled";
          transactionId: string | null;
        },
        Name
      >;
      handleEvent: FunctionReference<
        "mutation",
        "internal",
        { event: any; webhookId?: string },
        null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          before?: number;
          limit?: number;
          status?: "queued" | "sent" | "failed" | "cancelled";
        },
        {
          nextCursor: number | null;
          page: Array<{
            campaignTags: Array<string>;
            channel: "email" | "sms";
            createdAt: number;
            errorMessage: string | null;
            messageId: string;
            recipientCount: number;
            status: "queued" | "sent" | "failed" | "cancelled";
            subject: string | null;
            transactionId: string | null;
          }>;
        },
        Name
      >;
      refreshStatus: FunctionReference<
        "action",
        "internal",
        { apiKey: string; messageId: string },
        number,
        Name
      >;
    };
  };
