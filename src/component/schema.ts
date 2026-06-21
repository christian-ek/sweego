import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  onEvent,
  vAttachment,
  vChannel,
  vDeliveryStatus,
  vEmailAddress,
  vEmailRecipient,
  vListUnsub,
  vSendStatus,
  vSmsRecipient,
  vVariables,
} from "./shared.js";

export default defineSchema({
  // A logical send request. One row per `sendEmail` / `sendSms` / `sendBulkEmail`
  // call. Content is stored inline; the whole document must fit within Convex's
  // ~1 MiB limit (so keep attachments small).
  messages: defineTable({
    channel: vChannel,
    provider: v.string(),
    status: vSendStatus,
    bulk: v.boolean(),

    // Recipients (per channel).
    emailRecipients: v.optional(v.array(vEmailRecipient)),
    smsRecipients: v.optional(v.array(vSmsRecipient)),

    // Email fields.
    from: v.optional(vEmailAddress),
    subject: v.optional(v.string()),
    cc: v.optional(v.array(vEmailAddress)),
    bcc: v.optional(v.array(vEmailAddress)),
    replyTo: v.optional(vEmailAddress),
    html: v.optional(v.string()),
    text: v.optional(v.string()),
    templateId: v.optional(v.string()),
    variables: v.optional(vVariables),
    attachments: v.optional(v.array(vAttachment)),
    headers: v.optional(v.record(v.string(), v.string())),
    listUnsub: v.optional(vListUnsub),
    expires: v.optional(v.string()),
    campaignId: v.optional(v.string()),
    campaignTags: v.optional(v.array(v.string())),
    campaignType: v.optional(v.string()),
    compressStyle: v.optional(v.boolean()),
    forceInlineStyle: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),

    // SMS fields.
    senderId: v.optional(v.string()),
    shortenUrls: v.optional(v.boolean()),
    shortenWithProtocol: v.optional(v.boolean()),
    bat: v.optional(v.boolean()),

    // Lifecycle.
    transactionId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    creditLeft: v.optional(v.string()),
    finalizedAt: v.number(),

    // Denormalized for admin list/search (populated on enqueue): `searchText`
    // is a lowercased subject + recipients blob; `primaryTag` is the first
    // campaignTag (filter by campaign / message type).
    searchText: v.optional(v.string()),
    primaryTag: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_finalizedAt", ["finalizedAt"])
    .index("by_transactionId", ["transactionId"])
    .index("by_primaryTag", ["primaryTag"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["status", "primaryTag"],
    }),

  // One row per recipient (per swg_uid returned by Sweego). Webhook events are
  // matched to a delivery via `swgUid`.
  deliveries: defineTable({
    messageId: v.id("messages"),
    swgUid: v.string(),
    recipientKey: v.string(),
    channel: vChannel,
    status: vDeliveryStatus,
    lastEventType: v.optional(v.string()),
    delivered: v.boolean(),
    bounced: v.boolean(),
    softBounced: v.boolean(),
    complained: v.boolean(),
    unsubscribed: v.boolean(),
    opened: v.boolean(),
    clicked: v.boolean(),
    stopped: v.boolean(),
    errorMessage: v.optional(v.string()),
    finalizedAt: v.number(),
  })
    .index("by_swgUid", ["swgUid"])
    .index("by_messageId", ["messageId"]),

  // Raw webhook events, kept for auditing/debugging.
  events: defineTable({
    swgUid: v.string(),
    messageId: v.optional(v.id("messages")),
    deliveryId: v.optional(v.id("deliveries")),
    channel: v.optional(vChannel),
    eventType: v.string(),
    // The `webhook-id` header (Standard-Webhooks message id) — used to
    // deduplicate redelivered/replayed webhooks.
    webhookId: v.optional(v.string()),
    eventId: v.optional(v.string()),
    transactionId: v.optional(v.string()),
    timestamp: v.optional(v.string()),
    payload: v.any(),
    createdAt: v.number(),
  })
    .index("by_swgUid", ["swgUid"])
    .index("by_messageId", ["messageId"])
    .index("by_webhookId", ["webhookId"])
    .index("by_createdAt", ["createdAt"]),

  // Singleton row holding the latest webhook-event callback handle, refreshed
  // whenever a message is enqueued. The webhook handler reads it to dispatch
  // `onEvent` (which arrives independently of any send).
  config: defineTable({
    onEvent: v.optional(onEvent),
  }),
});
