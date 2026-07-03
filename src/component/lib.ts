import { Workpool } from "@convex-dev/workpool";
import {
  type FunctionHandle,
  type PaginationResult,
  paginationOptsValidator,
} from "convex/server";
import { v } from "convex/values";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server.js";
import { paginator } from "convex-helpers/server/pagination";
import schema from "./schema.js";
import {
  classifyEvent,
  type DeliveryStatus,
  type SweegoEvent,
  vChannel,
  vDeliveryStatus,
  vMessageInput,
  vOptions,
  vSendStatus,
} from "./shared.js";
import {
  buildSendRequest,
  fetchLogStatus,
  fetchSmsEstimate,
  parseSendResponse,
  PERMANENT_ERROR_CODES,
  sanitizeSweegoError,
  sweegoFetch,
} from "./sweego.js";
import { pickString } from "./utils.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SEND_POOL_SIZE = 5;
const CALLBACK_POOL_SIZE = 4;
const FINALIZED_EPOCH = Number.MAX_SAFE_INTEGER;
const FINALIZED_RETENTION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const ABANDONED_RETENTION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const EVENT_RETENTION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SEARCH_RESULT_CAP = 50; // relevance-ranked search results returned
const CLEANUP_BATCH = 100;
// Upper bound on per-message deliveries read into a status view / polled, to
// keep reads bounded for very large bulk sends.
const MAX_DELIVERIES = 1024;

const sendPool = new Workpool(components.sendWorkpool, {
  maxParallelism: SEND_POOL_SIZE,
});
const callbackPool = new Workpool(components.callbackWorkpool, {
  maxParallelism: CALLBACK_POOL_SIZE,
});

/* -------------------------------------------------------------------------- */
/*  Return validators                                                         */
/* -------------------------------------------------------------------------- */

const vDeliveryView = v.object({
  swgUid: v.string(),
  recipientKey: v.string(),
  channel: vChannel,
  status: vDeliveryStatus,
  lastEventType: v.union(v.string(), v.null()),
  delivered: v.boolean(),
  bounced: v.boolean(),
  softBounced: v.boolean(),
  complained: v.boolean(),
  unsubscribed: v.boolean(),
  opened: v.boolean(),
  clicked: v.boolean(),
  stopped: v.boolean(),
  errorMessage: v.union(v.string(), v.null()),
});

const vStatusView = v.object({
  status: vSendStatus,
  channel: vChannel,
  transactionId: v.union(v.string(), v.null()),
  errorMessage: v.union(v.string(), v.null()),
  creditLeft: v.union(v.string(), v.null()),
  deliveries: v.array(vDeliveryView),
});

const vSendActionResult = v.union(
  v.null(),
  v.object({
    swgUids: v.record(v.string(), v.string()),
    transactionId: v.optional(v.string()),
    creditLeft: v.optional(v.string()),
    channel: v.optional(v.string()),
    provider: v.optional(v.string()),
  }),
);

function deliveryView(d: Doc<"deliveries">) {
  return {
    swgUid: d.swgUid,
    recipientKey: d.recipientKey,
    channel: d.channel,
    status: d.status,
    lastEventType: d.lastEventType ?? null,
    delivered: d.delivered,
    bounced: d.bounced,
    softBounced: d.softBounced,
    complained: d.complained,
    unsubscribed: d.unsubscribed,
    opened: d.opened,
    clicked: d.clicked,
    stopped: d.stopped,
    errorMessage: d.errorMessage ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Enqueue                                                                   */
/* -------------------------------------------------------------------------- */

// Enqueue a message to be sent durably by the send workpool.
export const enqueueMessage = mutation({
  args: {
    options: vOptions,
    message: vMessageInput,
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    const { message, options } = args;

    // Treat empty strings as absent so an empty body field can't slip through.
    const present = (s: string | undefined) =>
      typeof s === "string" && s.length > 0;
    const hasHtml = present(message.html);
    const hasText = present(message.text);
    const hasTemplate = present(message.templateId);

    if (hasHtml && hasTemplate) {
      throw new Error("Provide either html or templateId, not both.");
    }

    if (message.channel === "email") {
      if (!message.from) throw new Error("Email requires a `from` address.");
      if (!message.emailRecipients?.length) {
        throw new Error("Email requires at least one recipient.");
      }
      if (message.bulk && message.emailRecipients.length < 2) {
        throw new Error(
          "Bulk email (/send/bulk/email) requires at least 2 recipients.",
        );
      }
      // Sweego requires a text part or a template; `html` is supplementary and
      // is rejected on its own ("Either 'message-txt' or 'template-id' is
      // required"). Fail fast locally rather than after a permanent 422.
      if (!hasText && !hasTemplate) {
        throw new Error(
          "Email requires `text` or a `templateId`; `html` alone is rejected by Sweego (html is supplementary to a text/template body).",
        );
      }
      if (!hasTemplate && message.subject === undefined) {
        throw new Error("Email requires a subject when not using a template.");
      }
    } else {
      if (!message.smsRecipients?.length) {
        throw new Error("SMS requires at least one recipient.");
      }
      if (!message.campaignType) {
        throw new Error(
          "SMS requires a campaignType ('transac' or 'market').",
        );
      }
      if (hasHtml) {
        throw new Error("SMS does not support html; use text or templateId.");
      }
      if (hasText && hasTemplate) {
        throw new Error("Provide either text or templateId for SMS, not both.");
      }
      if (!hasText && !hasTemplate) {
        throw new Error("SMS requires text or templateId.");
      }
    }

    // Denormalized fields for admin list/search (see schema): a lowercased
    // subject + recipients blob, and the first campaign tag.
    const recipientText =
      message.channel === "email"
        ? (message.emailRecipients ?? []).map((r) => r.email).join(" ")
        : (message.smsRecipients ?? []).map((r) => r.num).join(" ");
    const searchText = [message.subject, recipientText]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" ")
      .toLowerCase();

    const messageId = await ctx.db.insert("messages", {
      ...message,
      // Normalize empty body fields to absent so they aren't sent to Sweego.
      html: hasHtml ? message.html : undefined,
      text: hasText ? message.text : undefined,
      templateId: hasTemplate ? message.templateId : undefined,
      provider: options.provider,
      status: "queued",
      finalizedAt: FINALIZED_EPOCH,
      searchText: searchText.length > 0 ? searchText : undefined,
      primaryTag: message.campaignTags?.[0],
    });

    // Remember the latest event callback so the webhook handler can dispatch it.
    await upsertConfig(ctx, options.onEvent);

    await sendPool.enqueueAction(
      ctx,
      internal.lib.sendMessage,
      { messageId, options },
      {
        retry: {
          maxAttempts: options.retryAttempts,
          initialBackoffMs: options.initialBackoffMs,
          base: 2,
        },
        context: { messageId },
        onComplete: internal.lib.onSendComplete,
      },
    );

    return messageId;
  },
});

async function upsertConfig(
  ctx: MutationCtx,
  onEvent: { fnHandle: string } | undefined,
) {
  // Only register/replace when a handle is actually supplied. A send that
  // omits onEvent must never clear a previously-registered handle — the
  // webhook callback is global and arrives independently of any send.
  if (!onEvent) return;
  const existing = await ctx.db.query("config").unique();
  if (!existing) {
    await ctx.db.insert("config", { onEvent });
  } else if (existing.onEvent?.fnHandle !== onEvent.fnHandle) {
    await ctx.db.patch("config", existing._id, { onEvent });
  }
}

/* -------------------------------------------------------------------------- */
/*  Send (durable action)                                                     */
/* -------------------------------------------------------------------------- */

export const sendMessage = internalAction({
  args: { messageId: v.id("messages"), options: vOptions },
  returns: vSendActionResult,
  handler: async (ctx, args) => {
    const message = await ctx.runQuery(internal.lib.getMessage, {
      messageId: args.messageId,
    });
    if (!message || message.status !== "queued") {
      // Cancelled, already sent, or cleaned up — nothing to do.
      return null;
    }

    const { path, body } = buildSendRequest(message);

    const response = await sweegoFetch(args.options.apiKey, path, {
      method: "POST",
      json: body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      if (PERMANENT_ERROR_CODES.has(response.status)) {
        const errorMessage = sanitizeSweegoError(response.status, errorText);
        await ctx.runMutation(internal.lib.recordFailed, {
          messageId: args.messageId,
          errorMessage,
        });
        // Returning (not throwing) prevents the workpool from retrying.
        return null;
      }
      // Transient (429, 5xx, 409, …): throw so the workpool retries.
      throw new Error(sanitizeSweegoError(response.status, errorText));
    }

    // The request succeeded. Never throw past this point: Sweego has no
    // idempotency key, so a retry here would re-send the message. If the body
    // is unparseable we still treat the send as accepted (with no swg_uids).
    const data: unknown = await response.json().catch(() => null);
    const result = parseSendResponse(data ?? {});
    return {
      swgUids: result.swgUids,
      transactionId: result.transactionId,
      creditLeft: result.creditLeft,
      channel: result.channel,
      provider: result.provider,
    };
  },
});

export const onSendComplete = sendPool.defineOnComplete({
  context: v.object({ messageId: v.id("messages") }),
  handler: async (ctx, args) => {
    const { messageId } = args.context;
    if (args.result.kind === "success") {
      const value = args.result.returnValue as {
        swgUids?: Record<string, string>;
        transactionId?: string;
        creditLeft?: string;
      } | null;
      if (!value) return; // permanent failure already recorded, or no-op
      await recordSentHandler(ctx, {
        messageId,
        swgUids: value.swgUids ?? {},
        transactionId: value.transactionId,
        creditLeft: value.creditLeft,
      });
    } else if (args.result.kind === "failed") {
      await recordFailedHandler(ctx, {
        messageId,
        errorMessage: args.result.error,
      });
    } else if (args.result.kind === "canceled") {
      await recordCancelledHandler(ctx, messageId);
    }
  },
});

/* -------------------------------------------------------------------------- */
/*  Recording outcomes                                                        */
/* -------------------------------------------------------------------------- */

async function recordSentHandler(
  ctx: MutationCtx,
  args: {
    messageId: Id<"messages">;
    swgUids: Record<string, string>;
    transactionId?: string;
    creditLeft?: string;
  },
) {
  const message = await ctx.db.get("messages", args.messageId);
  // Only the initial queued -> sent transition records deliveries; this guards
  // against cancellation and any (unexpected) repeated completion.
  if (!message || message.status !== "queued") return;

  await ctx.db.patch("messages", args.messageId, {
    status: "sent",
    transactionId: args.transactionId,
    creditLeft: args.creditLeft,
    finalizedAt: Date.now(),
  });

  for (const [recipientKey, swgUid] of Object.entries(args.swgUids)) {
    await ctx.db.insert("deliveries", {
      messageId: args.messageId,
      swgUid,
      recipientKey,
      channel: message.channel,
      status: "sent",
      delivered: false,
      bounced: false,
      softBounced: false,
      complained: false,
      unsubscribed: false,
      opened: false,
      clicked: false,
      stopped: false,
      finalizedAt: FINALIZED_EPOCH,
    });
  }
}

async function recordFailedHandler(
  ctx: MutationCtx,
  args: { messageId: Id<"messages">; errorMessage: string },
) {
  const message = await ctx.db.get("messages", args.messageId);
  if (!message || message.status !== "queued") return;
  await ctx.db.patch("messages", args.messageId, {
    status: "failed",
    errorMessage: args.errorMessage,
    finalizedAt: Date.now(),
  });
}

async function recordCancelledHandler(
  ctx: MutationCtx,
  messageId: Id<"messages">,
) {
  const message = await ctx.db.get("messages", messageId);
  if (!message || message.status !== "queued") return;
  await ctx.db.patch("messages", messageId, {
    status: "cancelled",
    finalizedAt: Date.now(),
  });
}

export const recordFailed = internalMutation({
  args: { messageId: v.id("messages"), errorMessage: v.string() },
  returns: v.null(),
  handler: (ctx, args) => recordFailedHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*  Cancel                                                                    */
/* -------------------------------------------------------------------------- */

// Cancel a message if it has not yet been handed to Sweego.
export const cancel = mutation({
  args: { messageId: v.id("messages") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get("messages", args.messageId);
    if (!message) throw new Error("Message not found");
    if (message.status !== "queued") return false;
    await ctx.db.patch("messages", args.messageId, {
      status: "cancelled",
      finalizedAt: Date.now(),
    });
    return true;
  },
});

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

export const getMessage = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => ctx.db.get("messages", args.messageId),
});

// Aggregate status of a message plus per-recipient delivery state.
export const getStatus = query({
  args: { messageId: v.id("messages") },
  returns: v.union(v.null(), vStatusView),
  handler: async (ctx, args) => {
    const message = await ctx.db.get("messages", args.messageId);
    if (!message) return null;
    const deliveries = await ctx.db
      .query("deliveries")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .take(MAX_DELIVERIES);
    return {
      status: message.status,
      channel: message.channel,
      transactionId: message.transactionId ?? null,
      errorMessage: message.errorMessage ?? null,
      creditLeft: message.creditLeft ?? null,
      deliveries: deliveries.map(deliveryView),
    };
  },
});

// The full stored message plus its deliveries.
export const get = query({
  args: { messageId: v.id("messages") },
  returns: v.union(
    v.null(),
    v.object({
      ...schema.tables.messages.validator.fields,
      _id: v.id("messages"),
      _creationTime: v.number(),
      deliveries: v.array(vDeliveryView),
    }),
  ),
  handler: async (ctx, args) => {
    const message = await ctx.db.get("messages", args.messageId);
    if (!message) return null;
    const deliveries = await ctx.db
      .query("deliveries")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .take(MAX_DELIVERIES);
    return { ...message, deliveries: deliveries.map(deliveryView) };
  },
});

// A lightweight, paginated list of recent messages (newest first) for admin /
// audit views. Drill into getStatus/get for per-recipient delivery detail.
const vMessageListItem = v.object({
  messageId: v.id("messages"),
  channel: vChannel,
  status: vSendStatus,
  subject: v.union(v.string(), v.null()),
  recipientCount: v.number(),
  recipients: v.array(v.string()),
  transactionId: v.union(v.string(), v.null()),
  errorMessage: v.union(v.string(), v.null()),
  campaignTags: v.array(v.string()),
  createdAt: v.number(),
});

function messageListItem(m: Doc<"messages">) {
  return {
    messageId: m._id,
    channel: m.channel,
    status: m.status,
    subject: m.subject ?? null,
    recipientCount: m.emailRecipients?.length ?? m.smsRecipients?.length ?? 0,
    recipients:
      m.channel === "email"
        ? (m.emailRecipients ?? []).map((r) => r.email)
        : (m.smsRecipients ?? []).map((r) => r.num),
    transactionId: m.transactionId ?? null,
    errorMessage: m.errorMessage ?? null,
    campaignTags: m.campaignTags ?? [],
    createdAt: m._creationTime,
  };
}

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(vSendStatus),
    tag: v.optional(v.string()),
    channel: v.optional(vChannel),
    // Inclusive creation-time bounds (epoch ms).
    start: v.optional(v.number()),
    end: v.optional(v.number()),
  },
  // Typed PaginationResult so the page shape flows to consumers (no `any`
  // across the component boundary). Compatible with `usePaginatedQuery`.
  returns: v.object({
    page: v.array(vMessageListItem),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null()
      )
    ),
  }),
  handler: async (ctx, args) => {
    const { status, tag, channel, start, end } = args;
    // `.paginate()` is app-only; components page via the convex-helpers
    // `paginator` (component-safe). It has no `.filter()`, so status + tag
    // combine through a composite index, and the coarse `channel` rides a
    // streamed `filterWith` (a no-op when unset). Date bounds use the implicit
    // trailing `_creationTime`.
    const db = paginator(ctx.db, schema);
    const opts = args.paginationOpts;
    const matchesChannel = async (d: Doc<"messages">) =>
      channel === undefined || d.channel === channel;
    let result: PaginationResult<Doc<"messages">>;
    if (status !== undefined && tag !== undefined) {
      result = await db
        .query("messages")
        .withIndex("by_status_primaryTag", (ix) => {
          const base = ix.eq("status", status).eq("primaryTag", tag);
          if (start !== undefined && end !== undefined)
            return base.gte("_creationTime", start).lte("_creationTime", end);
          if (start !== undefined) return base.gte("_creationTime", start);
          if (end !== undefined) return base.lte("_creationTime", end);
          return base;
        })
        .order("desc")
        .filterWith(matchesChannel)
        .paginate(opts);
    } else if (status !== undefined) {
      result = await db
        .query("messages")
        .withIndex("by_status", (ix) => {
          const base = ix.eq("status", status);
          if (start !== undefined && end !== undefined)
            return base.gte("_creationTime", start).lte("_creationTime", end);
          if (start !== undefined) return base.gte("_creationTime", start);
          if (end !== undefined) return base.lte("_creationTime", end);
          return base;
        })
        .order("desc")
        .filterWith(matchesChannel)
        .paginate(opts);
    } else if (tag !== undefined) {
      result = await db
        .query("messages")
        .withIndex("by_primaryTag", (ix) => {
          const base = ix.eq("primaryTag", tag);
          if (start !== undefined && end !== undefined)
            return base.gte("_creationTime", start).lte("_creationTime", end);
          if (start !== undefined) return base.gte("_creationTime", start);
          if (end !== undefined) return base.lte("_creationTime", end);
          return base;
        })
        .order("desc")
        .filterWith(matchesChannel)
        .paginate(opts);
    } else {
      result = await db
        .query("messages")
        .withIndex("by_creation_time", (ix) => {
          if (start !== undefined && end !== undefined)
            return ix.gte("_creationTime", start).lte("_creationTime", end);
          if (start !== undefined) return ix.gte("_creationTime", start);
          if (end !== undefined) return ix.lte("_creationTime", end);
          return ix;
        })
        .order("desc")
        .filterWith(matchesChannel)
        .paginate(opts);
    }
    return { ...result, page: result.page.map(messageListItem) };
  },
});

// Full-text search over subject + recipients (relevance-ranked, capped, NOT
// paginated — search indexes are not orderable). status/tag constrain via the
// index filter fields; the creation-time range is applied in memory over the
// capped result set (so a date-filtered search may return fewer than the cap).
export const search = query({
  args: {
    search: v.string(),
    status: v.optional(vSendStatus),
    tag: v.optional(v.string()),
    channel: v.optional(vChannel),
    start: v.optional(v.number()),
    end: v.optional(v.number()),
  },
  returns: v.object({ page: v.array(vMessageListItem) }),
  handler: async (ctx, args) => {
    const term = args.search.trim();
    if (term.length === 0) return { page: [] };
    const { status, tag, channel, start, end } = args;
    const rows = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (q) => {
        let s = q.search("searchText", term);
        if (status !== undefined) s = s.eq("status", status);
        if (tag !== undefined) s = s.eq("primaryTag", tag);
        if (channel !== undefined) s = s.eq("channel", channel);
        return s;
      })
      .take(SEARCH_RESULT_CAP);
    const inRange = rows.filter(
      (r) =>
        (start === undefined || r._creationTime >= start) &&
        (end === undefined || r._creationTime <= end),
    );
    return { page: inRange.map(messageListItem) };
  },
});

// Earliest message creation time (for a date-range picker default), or null
// when no messages exist yet.
export const bounds = query({
  args: {},
  returns: v.object({ earliest: v.union(v.number(), v.null()) }),
  handler: async (ctx) => {
    const first = await ctx.db
      .query("messages")
      .withIndex("by_creation_time")
      .order("asc")
      .first();
    return { earliest: first?._creationTime ?? null };
  },
});

/* -------------------------------------------------------------------------- */
/*  Webhook event handling                                                    */
/* -------------------------------------------------------------------------- */

const DELIVERY_RANK: Record<DeliveryStatus, number> = {
  pending: 0,
  sent: 1,
  soft_bounced: 2,
  delivered: 3,
  bounced: 4,
  undelivered: 4,
  stopped: 4,
};

const TERMINAL_STATUSES = new Set<DeliveryStatus>([
  "delivered",
  "bounced",
  "undelivered",
  "stopped",
]);

// Compute the patch to apply to a delivery for a classified event. Returns null
// when nothing about the delivery's tracked state changes.
function computeDeliveryPatch(
  delivery: Doc<"deliveries">,
): (kind: ReturnType<typeof classifyEvent>) => Partial<Doc<"deliveries">> | null {
  const currentRank = DELIVERY_RANK[delivery.status];
  return (kind) => {
    const patch: Partial<Doc<"deliveries">> = {};
    const upgradeTo = (status: DeliveryStatus) => {
      if (DELIVERY_RANK[status] > currentRank) patch.status = status;
    };
    switch (kind) {
      case "sent":
      case "sms_sent":
        upgradeTo("sent");
        break;
      case "delivered":
        upgradeTo("delivered");
        if (!delivery.delivered) patch.delivered = true;
        break;
      case "soft_bounce":
        upgradeTo("soft_bounced");
        if (!delivery.softBounced) patch.softBounced = true;
        break;
      case "hard_bounce":
        upgradeTo("bounced");
        if (!delivery.bounced) patch.bounced = true;
        break;
      case "sms_undelivered":
        upgradeTo("undelivered");
        break;
      case "sms_stop":
        upgradeTo("stopped");
        if (!delivery.stopped) patch.stopped = true;
        break;
      case "complaint":
        if (!delivery.complained) patch.complained = true;
        break;
      case "unsub":
        if (!delivery.unsubscribed) patch.unsubscribed = true;
        break;
      case "open":
        if (!delivery.opened) patch.opened = true;
        break;
      case "click":
      case "sms_click":
        if (!delivery.clicked) patch.clicked = true;
        break;
      case "inbound":
      case "unknown":
        break;
    }
    if (Object.keys(patch).length === 0) return null;
    if (
      patch.status &&
      TERMINAL_STATUSES.has(patch.status) &&
      delivery.finalizedAt === FINALIZED_EPOCH
    ) {
      patch.finalizedAt = Date.now();
    }
    return patch;
  };
}

// Handle a verified webhook event. The caller (client) verifies the signature
// before calling this; here we persist the raw event, update delivery state,
// and dispatch the onEvent callback.
export const handleEvent = mutation({
  args: { event: v.any(), webhookId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const raw = args.event;
    const eventType = pickString(raw, "event_type") ?? "";
    const swgUid = pickString(raw, "swg_uid") ?? "";
    const channelStr = pickString(raw, "channel");
    const channel =
      channelStr === "email" || channelStr === "sms" ? channelStr : undefined;
    const eventId = pickString(raw, "event_id");
    const transactionId = pickString(raw, "transaction_id");
    const timestamp = pickString(raw, "timestamp");

    if (!eventType || !swgUid) {
      console.warn(
        "[sweego] Webhook event missing event_type or swg_uid; ignoring.",
      );
      return;
    }

    // Idempotency: Sweego webhooks are at-least-once and may be replayed within
    // the tolerance window. Skip anything we've already processed for this
    // webhook-id so the delivery state and onEvent callback fire at most once.
    if (args.webhookId) {
      const seen = await ctx.db
        .query("events")
        .withIndex("by_webhookId", (q) => q.eq("webhookId", args.webhookId))
        .first();
      if (seen) {
        console.info(`[sweego] Duplicate webhook ${args.webhookId} ignored.`);
        return;
      }
    }

    const delivery = await ctx.db
      .query("deliveries")
      .withIndex("by_swgUid", (q) => q.eq("swgUid", swgUid))
      .unique();

    // Always record the raw event for auditing.
    await ctx.db.insert("events", {
      swgUid,
      messageId: delivery?.messageId,
      deliveryId: delivery?._id,
      channel: channel ?? delivery?.channel,
      eventType,
      webhookId: args.webhookId,
      eventId,
      transactionId,
      timestamp,
      payload: raw,
      createdAt: Date.now(),
    });

    if (!delivery) {
      console.info(
        `[sweego] No delivery found for swg_uid ${swgUid} (event ${eventType}); recorded for audit only.`,
      );
      return;
    }

    // Update delivery state from the event.
    const kind = classifyEvent(eventType);
    const patch = computeDeliveryPatch(delivery)(kind) ?? {};
    patch.lastEventType = eventType;
    await ctx.db.patch("deliveries", delivery._id, patch);

    // Dispatch the host app's onEvent callback (durably, via the callback pool).
    await enqueueCallbackIfExists(ctx, delivery.messageId, {
      eventType,
      channel: channel ?? delivery.channel,
      swgUid,
      eventId,
      transactionId,
      timestamp,
      raw,
    });
  },
});

async function enqueueCallbackIfExists(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  event: SweegoEvent,
) {
  const config = await ctx.db.query("config").unique();
  if (!config?.onEvent) return;
  const handle = config.onEvent.fnHandle as FunctionHandle<
    "mutation",
    { messageId: string; swgUid: string; event: SweegoEvent },
    void
  >;
  await callbackPool.enqueueMutation(ctx, handle, {
    messageId,
    swgUid: event.swgUid,
    event,
  });
}

/* -------------------------------------------------------------------------- */
/*  Estimate (SMS)                                                            */
/* -------------------------------------------------------------------------- */

export const estimateSms = action({
  args: { apiKey: v.string(), body: v.any() },
  returns: v.any(),
  handler: async (_ctx, args) => fetchSmsEstimate(args.apiKey, args.body),
});

/* -------------------------------------------------------------------------- */
/*  Refresh status (webhook-free polling fallback)                            */
/* -------------------------------------------------------------------------- */

function mapLogStatus(status: string): DeliveryStatus | undefined {
  const s = status.toLowerCase();
  if (s.includes("deliver") && !s.includes("undeliver")) return "delivered";
  if (s.includes("undeliver")) return "undelivered";
  if (s.includes("hard") || s.includes("bounce")) return "bounced";
  if (s.includes("soft")) return "soft_bounced";
  if (s.includes("stop")) return "stopped";
  if (s.includes("sent") || s.includes("accept")) return "sent";
  return undefined;
}

export const applyLogStatus = internalMutation({
  args: {
    deliveryId: v.id("deliveries"),
    remoteStatus: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get("deliveries", args.deliveryId);
    if (!delivery) return;
    const mapped = mapLogStatus(args.remoteStatus);
    const patch: Partial<Doc<"deliveries">> = {
      lastEventType: `log:${args.remoteStatus}`,
    };
    if (mapped && DELIVERY_RANK[mapped] > DELIVERY_RANK[delivery.status]) {
      patch.status = mapped;
      if (mapped === "delivered") patch.delivered = true;
      if (mapped === "bounced") patch.bounced = true;
      if (mapped === "soft_bounced") patch.softBounced = true;
      if (mapped === "stopped") patch.stopped = true;
      if (
        TERMINAL_STATUSES.has(mapped) &&
        delivery.finalizedAt === FINALIZED_EPOCH
      ) {
        patch.finalizedAt = Date.now();
      }
    }
    await ctx.db.patch("deliveries", args.deliveryId, patch);
  },
});

export const listDeliveries = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) =>
    ctx.db
      .query("deliveries")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .take(MAX_DELIVERIES),
});

// Poll Sweego's /logs/{swg_uid}/status for (up to MAX_DELIVERIES of) a message's
// deliveries and update local state. Useful if you haven't configured webhooks.
// Fetches are done in bounded-concurrency batches to avoid action timeouts.
export const refreshStatus = action({
  args: { apiKey: v.string(), messageId: v.id("messages") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const deliveries = await ctx.runQuery(internal.lib.listDeliveries, {
      messageId: args.messageId,
    });
    const CONCURRENCY = 10;
    let updated = 0;
    for (let i = 0; i < deliveries.length; i += CONCURRENCY) {
      const batch = deliveries.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((d) =>
          fetchLogStatus(args.apiKey, d.swgUid).then((r) => ({ d, r })),
        ),
      );
      for (const { d, r } of results) {
        if (!r) continue;
        await ctx.runMutation(internal.lib.applyLogStatus, {
          deliveryId: d._id,
          remoteStatus: r.status,
        });
        updated++;
      }
    }
    return updated;
  },
});

/* -------------------------------------------------------------------------- */
/*  Cleanup (retention)                                                       */
/*                                                                            */
/*  These mutations are intentionally PUBLIC so the host app can schedule     */
/*  them from its own crons (e.g. components.sweego.lib.cleanupOldMessages).   */
/*  See the "Data retention" section of the README for the cron setup.        */
/* -------------------------------------------------------------------------- */

async function deleteMessageCascade(ctx: MutationCtx, message: Doc<"messages">) {
  const deliveries = await ctx.db
    .query("deliveries")
    .withIndex("by_messageId", (q) => q.eq("messageId", message._id))
    .collect();
  for (const d of deliveries) await ctx.db.delete("deliveries", d._id);
  const events = await ctx.db
    .query("events")
    .withIndex("by_messageId", (q) => q.eq("messageId", message._id))
    .collect();
  for (const e of events) await ctx.db.delete("events", e._id);
  await ctx.db.delete("messages", message._id);
}

// Delete finalized (sent/failed/cancelled) messages older than `olderThan` ms.
export const cleanupOldMessages = mutation({
  args: { olderThan: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const olderThan = args.olderThan ?? FINALIZED_RETENTION_MS;
    const cutoff = Date.now() - olderThan;
    const old = await ctx.db
      .query("messages")
      .withIndex("by_finalizedAt", (q) => q.lt("finalizedAt", cutoff))
      .take(CLEANUP_BATCH);
    for (const message of old) await deleteMessageCascade(ctx, message);
    if (old.length > 0) console.log(`[sweego] Cleaned up ${old.length} messages`);
    if (old.length === CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, api.lib.cleanupOldMessages, {
        olderThan,
      });
    }
  },
});

// Delete never-finalized messages older than `olderThan` ms (e.g. stuck sends).
export const cleanupAbandonedMessages = mutation({
  args: { olderThan: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const olderThan = args.olderThan ?? ABANDONED_RETENTION_MS;
    const cutoff = Date.now() - olderThan;
    // Only never-finalized rows (finalizedAt === FINALIZED_EPOCH); finalized
    // ones are handled by cleanupOldMessages on their earlier finalizedAt. The
    // by_finalizedAt index has _creationTime auto-appended, so we range on it.
    const abandoned = await ctx.db
      .query("messages")
      .withIndex("by_finalizedAt", (q) =>
        q.eq("finalizedAt", FINALIZED_EPOCH).lt("_creationTime", cutoff),
      )
      .take(CLEANUP_BATCH);
    for (const message of abandoned) await deleteMessageCascade(ctx, message);
    if (abandoned.length > 0) {
      console.log(`[sweego] Cleaned up ${abandoned.length} abandoned messages`);
    }
    if (abandoned.length === CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, api.lib.cleanupAbandonedMessages, {
        olderThan,
      });
    }
  },
});

// Delete raw events older than `olderThan` ms. Events for a message are also
// removed when that message is cleaned up; this additionally reclaims
// audit-only events (unmatched swg_uid / inbound) that have no parent message.
export const cleanupOldEvents = mutation({
  args: { olderThan: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const olderThan = args.olderThan ?? EVENT_RETENTION_MS;
    const cutoff = Date.now() - olderThan;
    const old = await ctx.db
      .query("events")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(CLEANUP_BATCH);
    for (const event of old) await ctx.db.delete("events", event._id);
    if (old.length > 0) console.log(`[sweego] Cleaned up ${old.length} events`);
    if (old.length === CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, api.lib.cleanupOldEvents, { olderThan });
    }
  },
});

/* -------------------------------------------------------------------------- */
/*  Erasure (GDPR right to be forgotten)                                      */
/* -------------------------------------------------------------------------- */

const PURGE_SCAN_BATCH = 100;

// True when `email` (already lowercased) is a recipient of `m` — its to/cc/bcc
// addresses. `from`/`replyTo` are the sender side, not the data subject, so they
// are intentionally excluded.
function messageHasRecipient(m: Doc<"messages">, email: string): boolean {
  return [m.emailRecipients, m.cc, m.bcc].some((list) =>
    (list ?? []).some((r) => r.email.toLowerCase() === email),
  );
}

// Delete every message addressed to `email`, with its deliveries and events.
// PUBLIC so the host app can run it when it erases a person (GDPR right to
// erasure): schedule components.sweego.lib.purgeRecipient from your account-
// deletion mutation. Recipients live in an array, so there is no equality index
// to seek; we scan creation-time order in batches and self-reschedule via the
// cursor until the table is exhausted (each batch reads only PURGE_SCAN_BATCH
// messages, so reads stay bounded). Retention caps the table size and erasure is
// rare, so the scan stays cheap. Audit-only events with no parent message are
// not matched here — they carry no recipient address and age out via
// cleanupOldEvents.
export const purgeRecipient = mutation({
  args: {
    email: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (email.length === 0) return;
    const result = await paginator(ctx.db, schema)
      .query("messages")
      .withIndex("by_creation_time")
      .paginate({ numItems: PURGE_SCAN_BATCH, cursor: args.cursor ?? null });
    let purged = 0;
    for (const message of result.page) {
      if (messageHasRecipient(message, email)) {
        await deleteMessageCascade(ctx, message);
        purged++;
      }
    }
    if (purged > 0) {
      console.log(`[sweego] Purged ${purged} message(s) for an erased recipient`);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, api.lib.purgeRecipient, {
        email: args.email,
        cursor: result.continueCursor,
      });
    }
  },
});
