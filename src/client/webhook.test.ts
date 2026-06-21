import { describe, expect, it } from "vitest";
import { timingSafeEqual, verifySweegoSignature } from "./webhook.js";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

// Independently compute a Sweego-style signature the way the docs specify.
async function sign(
  secretB64: string,
  id: string,
  ts: string,
  body: string,
): Promise<string> {
  const key = base64ToBytes(secretB64);
  const ck = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    ck,
    new TextEncoder().encode(`${id}.${ts}.${body}`),
  );
  return bytesToBase64(mac);
}

const SECRET = btoa("super-secret-key-bytes-0123456789");
const ID = "msg_123";
const TS = "1769696506";
const BODY = JSON.stringify({ event_type: "delivered", swg_uid: "abc" });

describe("verifySweegoSignature", () => {
  it("accepts a valid signature", async () => {
    const signatureHeader = await sign(SECRET, ID, TS, BODY);
    expect(
      await verifySweegoSignature({
        secret: SECRET,
        id: ID,
        timestamp: TS,
        body: BODY,
        signatureHeader,
      }),
    ).toBe(true);
  });

  it("tolerates a v1,-prefixed signature (svix style)", async () => {
    const sig = await sign(SECRET, ID, TS, BODY);
    expect(
      await verifySweegoSignature({
        secret: SECRET,
        id: ID,
        timestamp: TS,
        body: BODY,
        signatureHeader: `v1,${sig}`,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = await sign(SECRET, ID, TS, BODY);
    expect(
      await verifySweegoSignature({
        secret: SECRET,
        id: ID,
        timestamp: TS,
        body: `${BODY} `,
        signatureHeader: sig,
      }),
    ).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const sig = await sign(SECRET, ID, TS, BODY);
    expect(
      await verifySweegoSignature({
        secret: btoa("a-totally-different-secret-value!"),
        id: ID,
        timestamp: TS,
        body: BODY,
        signatureHeader: sig,
      }),
    ).toBe(false);
  });

  it("rejects missing headers", async () => {
    expect(
      await verifySweegoSignature({
        secret: SECRET,
        id: "",
        timestamp: TS,
        body: BODY,
        signatureHeader: "",
      }),
    ).toBe(false);
  });

  it("enforces the timestamp tolerance window when set", async () => {
    const sig = await sign(SECRET, ID, TS, BODY);
    const ok = await verifySweegoSignature({
      secret: SECRET,
      id: ID,
      timestamp: TS,
      body: BODY,
      signatureHeader: sig,
      toleranceSeconds: 300,
      now: Number(TS) + 10,
    });
    const stale = await verifySweegoSignature({
      secret: SECRET,
      id: ID,
      timestamp: TS,
      body: BODY,
      signatureHeader: sig,
      toleranceSeconds: 300,
      now: Number(TS) + 10_000,
    });
    expect(ok).toBe(true);
    expect(stale).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("matches equal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });
  it("rejects differing strings", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });
  it("rejects differing lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
