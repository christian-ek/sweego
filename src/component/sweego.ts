import { DEFAULT_PROVIDER, SWEEGO_API_BASE_URL } from "./shared.js";

/* -------------------------------------------------------------------------- */
/*  HTTP                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * HTTP status codes from which retrying will never help. Everything else
 * (429 rate limits, 409 conflicts, 5xx) is treated as transient and retried
 * by the workpool. Derived from Sweego's documented status codes.
 */
export const PERMANENT_ERROR_CODES = new Set([
  400, // malformed request
  401, // bad / missing API key
  403, // forbidden / restricted account
  404, // resource not found
  405, // method not allowed
  406, // not acceptable
  410, // route is gone
  413, // request too large
  418, // I'm a teapot
  422, // validation error (missing / wrong-type field)
  501, // route / channel not implemented
]);

export type SweegoRequestInit = Omit<RequestInit, "body"> & { json?: unknown };

/** Low-level fetch against the Sweego API with the `Api-Key` auth header. */
export async function sweegoFetch(
  apiKey: string,
  path: string,
  init: SweegoRequestInit = {},
): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers ?? {});
  headers.set("Api-Key", apiKey);
  if (json !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${SWEEGO_API_BASE_URL}${path}`, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : (rest as RequestInit).body,
  });
}

/** Turn a non-OK Sweego response into a concise, non-leaky Error message. */
export function sanitizeSweegoError(status: number, errorText: string): string {
  if (status === 401 || status === 403) {
    return "Sweego authentication failed. Check your SWEEGO_API_KEY.";
  }
  if (status === 422) {
    return `Sweego rejected the request (422): ${truncate(errorText, 500)}`;
  }
  if (status === 404) return "Sweego resource not found (404).";
  if (status === 413) return "Sweego request too large (413).";
  if (status === 429) return "Sweego rate limit exceeded (429).";
  if (status >= 500) return `Sweego service error (${status}).`;
  return `Sweego API error (${status}): ${truncate(errorText, 300)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* -------------------------------------------------------------------------- */
/*  Request payload builders                                                  */
/* -------------------------------------------------------------------------- */

// Structural shape of a stored message that the payload builders need.
// `Doc<"messages">` is assignable to this.
export interface BuildableMessage {
  channel: "email" | "sms";
  provider: string;
  bulk: boolean;
  emailRecipients?: Array<{
    email: string;
    name?: string;
    variables?: Record<string, string | number | boolean>;
  }>;
  smsRecipients?: Array<{ num: string; region: string }>;
  from?: { email: string; name?: string };
  subject?: string;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  replyTo?: { email: string; name?: string };
  html?: string;
  text?: string;
  templateId?: string;
  variables?: Record<string, string | number | boolean>;
  attachments?: Array<{
    content: string;
    filename: string;
    contentId?: string;
    disposition?: "attachment" | "inline";
    isRelated?: boolean;
  }>;
  headers?: Record<string, string>;
  listUnsub?: { method?: "mailto" | "one-click"; value: string };
  expires?: string;
  campaignId?: string;
  campaignTags?: string[];
  campaignType?: string;
  compressStyle?: boolean;
  forceInlineStyle?: boolean;
  dryRun?: boolean;
  senderId?: string;
  shortenUrls?: boolean;
  shortenWithProtocol?: boolean;
  bat?: boolean;
}

type Json = Record<string, unknown>;

/** Drop keys whose value is `undefined`. */
function compact(obj: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function mapAttachments(message: BuildableMessage): Json[] | undefined {
  if (!message.attachments?.length) return undefined;
  return message.attachments.map((a) =>
    compact({
      content: a.content,
      filename: a.filename,
      content_id: a.contentId,
      disposition: a.disposition,
      is_related: a.isRelated,
    }),
  );
}

/** Fields common to single and bulk email payloads. */
function commonEmailFields(message: BuildableMessage): Json {
  return {
    channel: "email",
    provider: message.provider || DEFAULT_PROVIDER,
    from: message.from,
    subject: message.subject,
    "message-html": message.html,
    "message-txt": message.text,
    "template-id": message.templateId,
    attachments: mapAttachments(message),
    headers: message.headers,
    "list-unsub": message.listUnsub
      ? compact({
          method: message.listUnsub.method,
          value: message.listUnsub.value,
        })
      : undefined,
    expires: message.expires,
    "campaign-id": message.campaignId,
    "campaign-tags": message.campaignTags,
    "campaign-type": message.campaignType,
    compress_style: message.compressStyle,
    force_inline_style: message.forceInlineStyle,
    "dry-run": message.dryRun,
  };
}

function buildEmailPayload(message: BuildableMessage): Json {
  return compact({
    ...commonEmailFields(message),
    recipients: (message.emailRecipients ?? []).map((r) =>
      compact({ email: r.email, name: r.name }),
    ),
    cc: message.cc?.map((r) => compact({ email: r.email, name: r.name })),
    bcc: message.bcc?.map((r) => compact({ email: r.email, name: r.name })),
    "reply-to": message.replyTo
      ? compact({ email: message.replyTo.email, name: message.replyTo.name })
      : undefined,
    // Sweego only honors root-level `variables` for a single recipient on /send.
    variables: message.variables,
  });
}

function buildBulkEmailPayload(message: BuildableMessage): Json {
  return compact({
    ...commonEmailFields(message),
    // Bulk: per-recipient variables; no cc/bcc/reply-to.
    recipients: (message.emailRecipients ?? []).map((r) =>
      compact({ email: r.email, name: r.name, variables: r.variables }),
    ),
  });
}

function buildSmsPayload(message: BuildableMessage): Json {
  return compact({
    channel: "sms",
    provider: message.provider || DEFAULT_PROVIDER,
    "campaign-type": message.campaignType,
    recipients: (message.smsRecipients ?? []).map((r) => ({
      num: r.num,
      region: r.region.toUpperCase(),
    })),
    "message-txt": message.text,
    "template-id": message.templateId,
    variables: message.variables,
    "sender-id": message.senderId,
    "shorten-urls": message.shortenUrls,
    "shorten-with-protocol": message.shortenWithProtocol,
    bat: message.bat,
    "campaign-id": message.campaignId,
  });
}

/** Build the `{ path, body }` for a stored message. */
export function buildSendRequest(message: BuildableMessage): {
  path: string;
  body: Json;
} {
  if (message.channel === "sms") {
    return { path: "/send", body: buildSmsPayload(message) };
  }
  if (message.bulk) {
    return { path: "/send/bulk/email", body: buildBulkEmailPayload(message) };
  }
  return { path: "/send", body: buildEmailPayload(message) };
}

/* -------------------------------------------------------------------------- */
/*  Response parsing                                                          */
/* -------------------------------------------------------------------------- */

export interface SendResult {
  channel?: string;
  provider?: string;
  swgUids: Record<string, string>;
  transactionId?: string;
  creditLeft?: string;
}

/** Parse a Sweego `ModelOutSend` body into a normalized result. */
export function parseSendResponse(data: unknown): SendResult {
  const obj = (typeof data === "object" && data !== null ? data : {}) as Record<
    string,
    unknown
  >;
  const rawUids = obj["swg_uids"];
  const swgUids: Record<string, string> = {};
  if (typeof rawUids === "object" && rawUids !== null) {
    for (const [key, value] of Object.entries(rawUids as Record<string, unknown>)) {
      if (typeof value === "string") swgUids[key] = value;
    }
  }
  return {
    channel: typeof obj["channel"] === "string" ? (obj["channel"] as string) : undefined,
    provider:
      typeof obj["provider"] === "string" ? (obj["provider"] as string) : undefined,
    swgUids,
    transactionId:
      typeof obj["transaction_id"] === "string"
        ? (obj["transaction_id"] as string)
        : undefined,
    // Sweego documents credit_left as a string, but coerce a number defensively
    // so a numeric value isn't silently dropped.
    creditLeft:
      typeof obj["credit_left"] === "string"
        ? (obj["credit_left"] as string)
        : typeof obj["credit_left"] === "number"
          ? String(obj["credit_left"])
          : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  Logs (webhook-free status polling)                                        */
/* -------------------------------------------------------------------------- */

/** GET /logs/{swg_uid}/status — current remote status for one message. */
export async function fetchLogStatus(
  apiKey: string,
  swgUid: string,
): Promise<{ status: string; channel?: string } | null> {
  const response = await sweegoFetch(
    apiKey,
    `/logs/${encodeURIComponent(swgUid)}/status`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const data = (await response.json()) as Record<string, unknown>;
  const status = data["status"];
  if (typeof status !== "string") return null;
  return {
    status,
    channel: typeof data["channel"] === "string" ? (data["channel"] as string) : undefined,
  };
}

/** POST /sms/estimate — estimate the cost/segments of an SMS send. */
export async function fetchSmsEstimate(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await sweegoFetch(apiKey, "/sms/estimate", {
    method: "POST",
    json: body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      sanitizeSweegoError(response.status, JSON.stringify(data ?? {})),
    );
  }
  return data;
}
