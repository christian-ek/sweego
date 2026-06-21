import { v } from "convex/values";
import { type MessageId, Sweego, vOnEventArgs } from "@christian-ek/sweego";
import { components, internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";

// Instantiate the client. `testMode: true` submits email with Sweego's
// `dry-run` (validated, never delivered) — flip to false to send for real.
// Reads SWEEGO_API_KEY / SWEEGO_WEBHOOK_SECRET from the environment.
export const sweego: Sweego = new Sweego(components.sweego, {
  testMode: true,
  onEvent: internal.example.handleSweegoEvent,
});

// Send a basic HTML email.
export const sendTestEmail = internalAction({
  args: { to: v.string(), from: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const messageId = await sweego.sendEmail(ctx, {
      from: args.from,
      to: args.to,
      subject: "Hello from Sweego + Convex",
      html: "<h1>It works!</h1><p>Sent via the Sweego Convex component.</p>",
      text: "It works! Sent via the Sweego Convex component.",
    });
    await ctx.runMutation(internal.example.recordSent, {
      messageId,
      label: `email:${args.to}`,
    });
    return messageId;
  },
});

// Send an email rendered from a Sweego-hosted template with variables.
export const sendTemplatedEmail = internalAction({
  args: { to: v.string(), from: v.string(), templateId: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const messageId = await sweego.sendEmail(ctx, {
      from: args.from,
      to: args.to,
      subject: "Your receipt",
      templateId: args.templateId,
      variables: { name: "Ada Lovelace", amount: 42 },
    });
    await ctx.runMutation(internal.example.recordSent, {
      messageId,
      label: `template:${args.to}`,
    });
    return messageId;
  },
});

// Send a personalized bulk email (one template, many recipients).
export const sendBulk = internalAction({
  args: { from: v.string(), templateId: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const messageId = await sweego.sendBulkEmail(ctx, {
      from: args.from,
      subject: "Newsletter",
      templateId: args.templateId,
      recipients: [
        { email: "alice@example.com", variables: { name: "Alice" } },
        { email: "bob@example.com", variables: { name: "Bob" } },
      ],
    });
    await ctx.runMutation(internal.example.recordSent, {
      messageId,
      label: "bulk",
    });
    return messageId;
  },
});

// Send an SMS. `campaignType` is required by Sweego; `region` is the ISO code
// for bare-string recipients.
export const sendTestSms = internalAction({
  args: { to: v.string(), region: v.string(), senderId: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const messageId = await sweego.sendSms(ctx, {
      to: args.to,
      region: args.region,
      senderId: args.senderId,
      campaignType: "transac",
      text: "Your verification code is 123456",
    });
    await ctx.runMutation(internal.example.recordSent, {
      messageId,
      label: `sms:${args.to}`,
    });
    return messageId;
  },
});

// Check the status of a previously sent message.
export const checkStatus = internalAction({
  args: { messageId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return sweego.status(ctx, args.messageId as MessageId);
  },
});

/* -------------------------------------------------------------------------- */
/*  onEvent handler + bookkeeping                                             */
/* -------------------------------------------------------------------------- */

export const handleSweegoEvent = internalMutation({
  args: vOnEventArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log("[example] Sweego event", args.event.eventType, args.swgUid);
    const row = await ctx.db
      .query("sentMessages")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (row) {
      await ctx.db.patch("sentMessages", row._id, { lastEvent: args.event.eventType });
    }
  },
});

export const recordSent = internalMutation({
  args: { messageId: v.string(), label: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("sentMessages", {
      messageId: args.messageId,
      label: args.label,
    });
  },
});

export const listSent = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("sentMessages"),
      _creationTime: v.number(),
      messageId: v.string(),
      label: v.string(),
      lastEvent: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => ctx.db.query("sentMessages").collect(),
});

/* -------------------------------------------------------------------------- */
/*  Public functions for the demo frontend                                    */
/*                                                                            */
/*  Note: these are public so the example UI can call them. The Sweego API    */
/*  key never leaves the server — it lives in SWEEGO_API_KEY and is read by   */
/*  the component, not the browser.                                           */
/* -------------------------------------------------------------------------- */

// Build a client for a request. If the UI supplies an apiKey we use it (a
// "bring your own key" demo, like Loops); otherwise we fall back to the
// server's SWEEGO_API_KEY. Note: on a publicly reachable deployment, setting
// SWEEGO_API_KEY lets anyone calling this action send with *your* key — for a
// public demo, rely on the pasted key and leave the env key unset.
function clientFor(apiKey?: string): Sweego {
  if (!apiKey) return sweego;
  return new Sweego(components.sweego, {
    apiKey,
    testMode: true,
    onEvent: internal.example.handleSweegoEvent,
  });
}

export const sendEmail = action({
  args: {
    from: v.string(),
    to: v.string(),
    subject: v.string(),
    html: v.optional(v.string()),
    text: v.optional(v.string()),
    apiKey: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const messageId = await clientFor(args.apiKey).sendEmail(ctx, {
      from: args.from,
      to: args.to,
      subject: args.subject,
      html: args.html || undefined,
      text: args.text || undefined,
    });
    await ctx.runMutation(internal.example.recordSent, {
      messageId,
      label: `email → ${args.to}`,
    });
    return messageId;
  },
});

export const sendSms = action({
  args: {
    to: v.string(),
    region: v.string(),
    text: v.string(),
    campaignType: v.union(v.literal("transac"), v.literal("market")),
    senderId: v.optional(v.string()),
    apiKey: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const messageId = await clientFor(args.apiKey).sendSms(ctx, {
      to: args.to,
      region: args.region,
      text: args.text,
      campaignType: args.campaignType,
      senderId: args.senderId || undefined,
    });
    await ctx.runMutation(internal.example.recordSent, {
      messageId,
      label: `sms → ${args.to}`,
    });
    return messageId;
  },
});

// Reactive: re-runs (and the UI updates) whenever a webhook changes a delivery.
export const listRecent = query({
  args: {},
  returns: v.array(
    v.object({
      messageId: v.string(),
      label: v.string(),
      createdAt: v.number(),
      status: v.union(v.string(), v.null()),
      channel: v.union(v.string(), v.null()),
      errorMessage: v.union(v.string(), v.null()),
      deliveries: v.array(
        v.object({
          recipientKey: v.string(),
          status: v.string(),
          delivered: v.boolean(),
          bounced: v.boolean(),
          opened: v.boolean(),
          clicked: v.boolean(),
          complained: v.boolean(),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("sentMessages").order("desc").take(20);
    const out = [];
    for (const row of rows) {
      const status = await ctx.runQuery(components.sweego.lib.getStatus, {
        messageId: row.messageId,
      });
      out.push({
        messageId: row.messageId,
        label: row.label,
        createdAt: row._creationTime,
        status: status?.status ?? null,
        channel: status?.channel ?? null,
        errorMessage: status?.errorMessage ?? null,
        deliveries: (status?.deliveries ?? []).map((d) => ({
          recipientKey: d.recipientKey,
          status: d.status,
          delivered: d.delivered,
          bounced: d.bounced,
          opened: d.opened,
          clicked: d.clicked,
          complained: d.complained,
        })),
      });
    }
    return out;
  },
});
