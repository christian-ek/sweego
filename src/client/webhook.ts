/**
 * Verification of Sweego webhook signatures.
 *
 * Sweego signs webhooks with HMAC-SHA256 in a Standard-Webhooks / svix-*style*
 * scheme, but it is NOT drop-in svix-compatible:
 *   - headers: `webhook-id`, `webhook-timestamp` (Unix seconds), `webhook-signature`
 *   - signed string: `{id}.{timestamp}.{rawBody}` over the RAW, unparsed body
 *   - the HMAC key is the secret AFTER base64-decoding it
 *   - the `webhook-signature` value is a bare base64 digest (no `v1,` prefix,
 *     no space-delimited list), though we tolerate those defensively.
 *
 * Implemented with Web Crypto (`crypto.subtle`) so it runs in Convex's V8
 * runtime without any Node-only dependency.
 */

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const arr = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

/** Constant-time string comparison to avoid timing side channels. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** Read Sweego's signature headers (case-insensitive via the Headers API). */
export function readWebhookHeaders(headers: Headers): WebhookHeaders {
  return {
    id: headers.get("webhook-id"),
    timestamp: headers.get("webhook-timestamp"),
    signature: headers.get("webhook-signature"),
  };
}

export interface VerifyOptions {
  /** The webhook signing secret (as shown in the Sweego dashboard). */
  secret: string;
  /** `webhook-id` header. */
  id: string;
  /** `webhook-timestamp` header (Unix seconds). */
  timestamp: string;
  /** The RAW request body, exactly as received. */
  body: string;
  /** `webhook-signature` header value. */
  signatureHeader: string;
  /** If > 0, reject when |now - timestamp| exceeds this many seconds. */
  toleranceSeconds?: number;
  /** Override "now" (Unix seconds) — for testing. */
  now?: number;
}

/** Returns true iff the signature is valid for the given raw body + headers. */
export async function verifySweegoSignature(
  options: VerifyOptions,
): Promise<boolean> {
  const { id, timestamp, body, signatureHeader } = options;
  if (!id || !timestamp || !signatureHeader) return false;

  if (options.toleranceSeconds && options.toleranceSeconds > 0) {
    const ts = Number(timestamp);
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > options.toleranceSeconds) {
      return false;
    }
  }

  // The secret is delivered base64-encoded; decode to the raw HMAC key bytes.
  // Tolerate a leading "whsec_" and fall back to UTF-8 bytes if not base64.
  const rawSecret = options.secret.startsWith("whsec_")
    ? options.secret.slice("whsec_".length)
    : options.secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(rawSecret);
  } catch {
    console.warn(
      "[sweego] Webhook secret is not valid base64; check SWEEGO_WEBHOOK_SECRET. Falling back to raw UTF-8 bytes.",
    );
    keyBytes = new TextEncoder().encode(rawSecret);
  }
  if (keyBytes.length === 0) {
    console.warn("[sweego] Webhook secret is empty; rejecting webhook.");
    return false;
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedContent = `${id}.${timestamp}.${body}`;
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(signedContent),
  );
  const expected = bytesToBase64(mac);

  // The header may be a single bare base64 digest, or (svix-style) a
  // space-delimited list of `version,signature` pairs. Accept any match.
  const candidates = signatureHeader
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.includes(",") ? part.slice(part.indexOf(",") + 1) : part));

  return candidates.some((candidate) => timingSafeEqual(candidate, expected));
}
