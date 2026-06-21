import {
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import { type Infer, v } from "convex/values";

// The Sweego API base URL. All requests go here.
export const SWEEGO_API_BASE_URL = "https://api.sweego.io";

// The default provider Sweego expects on every send request.
export const DEFAULT_PROVIDER = "sweego";

/* -------------------------------------------------------------------------- */
/*  Channels                                                                  */
/* -------------------------------------------------------------------------- */

export const vChannel = v.union(v.literal("email"), v.literal("sms"));
export type Channel = Infer<typeof vChannel>;

/* -------------------------------------------------------------------------- */
/*  Addresses / recipients                                                    */
/* -------------------------------------------------------------------------- */

// An email address with an optional display name, e.g. { email, name }.
export const vEmailAddress = v.object({
  email: v.string(),
  name: v.optional(v.string()),
});
export type EmailAddress = Infer<typeof vEmailAddress>;

// Variables passed to a Sweego template. Values are interpolated into
// `{{ placeholder }}` tokens; Sweego accepts string/number/boolean values.
export const vVariables = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean()),
);
export type Variables = Infer<typeof vVariables>;

// An email recipient. `variables` is only honored on the bulk endpoint
// (`/send/bulk/email`), where each recipient may be personalized.
export const vEmailRecipient = v.object({
  email: v.string(),
  name: v.optional(v.string()),
  variables: v.optional(vVariables),
});
export type EmailRecipient = Infer<typeof vEmailRecipient>;

// An SMS recipient: a phone number plus its ISO-3166 alpha-2 region (e.g. "FR").
export const vSmsRecipient = v.object({
  num: v.string(),
  region: v.string(),
});
export type SmsRecipient = Infer<typeof vSmsRecipient>;

/* -------------------------------------------------------------------------- */
/*  Email extras                                                              */
/* -------------------------------------------------------------------------- */

// A file attachment. `content` MUST be base64-encoded bytes. The total
// message (incl. attachments) must fit within a single Convex document
// (~1 MiB); use small attachments or host large files elsewhere.
export const vAttachment = v.object({
  content: v.string(),
  filename: v.string(),
  contentId: v.optional(v.string()),
  disposition: v.optional(
    v.union(v.literal("attachment"), v.literal("inline")),
  ),
  isRelated: v.optional(v.boolean()),
});
export type Attachment = Infer<typeof vAttachment>;

// The List-Unsubscribe header. For "mailto", `value` is an email; for
// "one-click", `value` is "<mailto:EMAIL>,<URL>".
export const vListUnsub = v.object({
  method: v.optional(v.union(v.literal("mailto"), v.literal("one-click"))),
  value: v.string(),
});
export type ListUnsub = Infer<typeof vListUnsub>;

// Email campaign type. Optional for email.
export const vEmailCampaignType = v.union(
  v.literal("market"),
  v.literal("newsletter"),
  v.literal("transac"),
);

// SMS campaign type. REQUIRED by Sweego for every SMS send.
export const vSmsCampaignType = v.union(
  v.literal("market"),
  v.literal("transac"),
);
export type SmsCampaignType = Infer<typeof vSmsCampaignType>;

/* -------------------------------------------------------------------------- */
/*  Statuses                                                                  */
/* -------------------------------------------------------------------------- */

// Lifecycle of a logical send (one `messages` row).
export const vSendStatus = v.union(
  v.literal("queued"), // enqueued, not yet handed to Sweego
  v.literal("sent"), // accepted by Sweego (swg_uids issued)
  v.literal("failed"), // permanent failure / retries exhausted
  v.literal("cancelled"), // cancelled before being sent
);
export type SendStatus = Infer<typeof vSendStatus>;

// Per-recipient delivery outcome (one `deliveries` row per swg_uid).
export const vDeliveryStatus = v.union(
  v.literal("pending"), // accepted, awaiting delivery events
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("soft_bounced"), // transient bounce, may still deliver
  v.literal("bounced"), // hard bounce (terminal)
  v.literal("undelivered"), // SMS not delivered (terminal)
  v.literal("stopped"), // SMS recipient opted out (terminal)
);
export type DeliveryStatus = Infer<typeof vDeliveryStatus>;

/* -------------------------------------------------------------------------- */
/*  Webhook events                                                            */
/* -------------------------------------------------------------------------- */

// Known Sweego email webhook event_type strings. Casing is inconsistent in
// Sweego's docs (e.g. "soft-bounce" vs "hard_bounce"), so we match defensively
// via `classifyEvent` rather than relying on these literally.
export const KNOWN_EMAIL_EVENT_TYPES = [
  "email_sent",
  "delivered",
  "soft-bounce",
  "hard_bounce",
  "list_unsub",
  "complaint",
  "email_opened",
  "email_clicked",
  "email_inbound",
] as const;

export const KNOWN_SMS_EVENT_TYPES = [
  "sms_sent",
  "sms_undelivered",
  "sms_stop",
  "sms_clicked",
] as const;

// A normalized webhook event handed to your `onEvent` handler. The raw,
// unmodified payload is always available on `raw`.
export const vSweegoEvent = v.object({
  eventType: v.string(),
  channel: v.optional(vChannel),
  swgUid: v.string(),
  eventId: v.optional(v.string()),
  transactionId: v.optional(v.string()),
  timestamp: v.optional(v.string()),
  raw: v.any(),
});
export type SweegoEvent = Infer<typeof vSweegoEvent>;

// Coarse classification of a Sweego event_type string, normalizing the
// documented hyphen/underscore inconsistencies (and the sms_stop/stop variant).
export type EventKind =
  | "sent"
  | "delivered"
  | "soft_bounce"
  | "hard_bounce"
  | "complaint"
  | "unsub"
  | "open"
  | "click"
  | "sms_sent"
  | "sms_undelivered"
  | "sms_stop"
  | "sms_click"
  | "inbound"
  | "unknown";

export function normalizeEventType(raw: string): string {
  return raw.trim().toLowerCase().replace(/-/g, "_");
}

export function classifyEvent(raw: string): EventKind {
  switch (normalizeEventType(raw)) {
    case "email_sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "soft_bounce":
      return "soft_bounce";
    case "hard_bounce":
    case "bounce":
      return "hard_bounce";
    case "complaint":
      return "complaint";
    case "list_unsub":
      return "unsub";
    case "email_opened":
      return "open";
    case "email_clicked":
      return "click";
    case "email_inbound":
      return "inbound";
    case "sms_sent":
      return "sms_sent";
    case "sms_undelivered":
      return "sms_undelivered";
    case "sms_stop":
    case "stop":
      return "sms_stop";
    case "sms_clicked":
      return "sms_click";
    default:
      return "unknown";
  }
}

/* -------------------------------------------------------------------------- */
/*  Runtime configuration                                                     */
/* -------------------------------------------------------------------------- */

// A reference to a mutation in the host app that runs after each event.
export const onEvent = v.object({ fnHandle: v.string() });

// Runtime configuration threaded from the client into the component on each
// send. Note: components cannot read the host app's environment variables, so
// the API key is passed in explicitly here.
export const vOptions = v.object({
  apiKey: v.string(),
  provider: v.string(),
  initialBackoffMs: v.number(),
  retryAttempts: v.number(),
  // When true, email sends use Sweego's `dry-run` (validated, never sent).
  testMode: v.boolean(),
  onEvent: v.optional(onEvent),
});
export type RuntimeConfig = Infer<typeof vOptions>;

/* -------------------------------------------------------------------------- */
/*  Message input (client -> component)                                       */
/* -------------------------------------------------------------------------- */

// The normalized message a client hands to the component's `enqueueMessage`
// mutation. Lifecycle fields (status, transactionId, finalizedAt, …) are added
// by the component, not provided here.
export const vMessageInput = v.object({
  channel: vChannel,
  bulk: v.boolean(),
  emailRecipients: v.optional(v.array(vEmailRecipient)),
  smsRecipients: v.optional(v.array(vSmsRecipient)),
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
  senderId: v.optional(v.string()),
  shortenUrls: v.optional(v.boolean()),
  shortenWithProtocol: v.optional(v.boolean()),
  bat: v.optional(v.boolean()),
});
export type MessageInput = Infer<typeof vMessageInput>;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

// Accepts either a structured address or an RFC-5322-ish "Name <email>" /
// "email" string and returns { email, name? }.
export function parseEmailAddress(
  input: string | EmailAddress,
): EmailAddress {
  if (typeof input !== "string") return input;
  const match = input.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (match) {
    const name = match[1].replace(/^["']|["']$/g, "").trim();
    const email = match[2].trim();
    return name ? { email, name } : { email };
  }
  return { email: input.trim() };
}

export function parseEmailAddresses(
  input: string | EmailAddress | Array<string | EmailAddress>,
): EmailAddress[] {
  const list = Array.isArray(input) ? input : [input];
  return list.map(parseEmailAddress);
}

/* -------------------------------------------------------------------------- */
/*  Ctx type utilities                                                        */
/* -------------------------------------------------------------------------- */

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
export type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;
