import { describe, expect, it } from "vitest";
import {
  type BuildableMessage,
  buildSendRequest,
  PERMANENT_ERROR_CODES,
  parseSendResponse,
  sanitizeSweegoError,
} from "./sweego.js";

const baseEmail: BuildableMessage = {
  channel: "email",
  provider: "sweego",
  bulk: false,
  from: { email: "a@x.com", name: "A" },
  subject: "Hi",
  emailRecipients: [{ email: "b@y.com" }],
  html: "<p>hi</p>",
};

describe("buildSendRequest (email)", () => {
  it("uses /send and hyphenated keys, dropping undefined fields", () => {
    const { path, body } = buildSendRequest(baseEmail);
    expect(path).toBe("/send");
    expect(body.channel).toBe("email");
    expect(body.provider).toBe("sweego");
    expect(body["message-html"]).toBe("<p>hi</p>");
    expect(body.subject).toBe("Hi");
    expect(body.recipients).toEqual([{ email: "b@y.com" }]);
    expect(body.from).toEqual({ email: "a@x.com", name: "A" });
    expect("message-txt" in body).toBe(false);
    expect("dry-run" in body).toBe(false);
  });

  it("maps attachments to Sweego's snake_case fields", () => {
    const { body } = buildSendRequest({
      ...baseEmail,
      attachments: [
        {
          content: "Zm9v",
          filename: "f.txt",
          contentId: "cid",
          disposition: "inline",
          isRelated: true,
        },
      ],
    });
    expect(body.attachments).toEqual([
      {
        content: "Zm9v",
        filename: "f.txt",
        content_id: "cid",
        disposition: "inline",
        is_related: true,
      },
    ]);
  });

  it("includes dry-run when set", () => {
    const { body } = buildSendRequest({ ...baseEmail, dryRun: true });
    expect(body["dry-run"]).toBe(true);
  });
});

describe("buildSendRequest (bulk email)", () => {
  it("routes to /send/bulk/email with per-recipient variables and no cc", () => {
    const { path, body } = buildSendRequest({
      ...baseEmail,
      bulk: true,
      html: undefined,
      templateId: "tmpl-1",
      emailRecipients: [
        { email: "b@y.com", variables: { name: "Bob" } },
        { email: "c@y.com", variables: { name: "Cara" } },
      ],
    });
    expect(path).toBe("/send/bulk/email");
    expect(body["template-id"]).toBe("tmpl-1");
    expect((body.recipients as Array<Record<string, unknown>>)[0]).toEqual({
      email: "b@y.com",
      variables: { name: "Bob" },
    });
    expect("cc" in body).toBe(false);
  });
});

describe("buildSendRequest (sms)", () => {
  it("builds an SMS payload with required campaign-type and sender-id", () => {
    const { path, body } = buildSendRequest({
      channel: "sms",
      provider: "sweego",
      bulk: false,
      smsRecipients: [{ num: "+33600000000", region: "FR" }],
      text: "hi",
      campaignType: "transac",
      senderId: "Acme",
      shortenUrls: false,
    });
    expect(path).toBe("/send");
    expect(body.channel).toBe("sms");
    expect(body["campaign-type"]).toBe("transac");
    expect(body["sender-id"]).toBe("Acme");
    expect(body["message-txt"]).toBe("hi");
    expect(body["shorten-urls"]).toBe(false);
    expect(body.recipients).toEqual([{ num: "+33600000000", region: "FR" }]);
  });
});

describe("parseSendResponse", () => {
  it("extracts swg_uids, transaction_id, credit_left", () => {
    const r = parseSendResponse({
      channel: "email",
      provider: "sweego",
      swg_uids: { "b@y.com": "uid1" },
      transaction_id: "tx1",
      credit_left: "100",
    });
    expect(r.swgUids).toEqual({ "b@y.com": "uid1" });
    expect(r.transactionId).toBe("tx1");
    expect(r.creditLeft).toBe("100");
  });

  it("tolerates a missing/empty body", () => {
    const r = parseSendResponse({});
    expect(r.swgUids).toEqual({});
    expect(r.transactionId).toBeUndefined();
  });
});

describe("error classification", () => {
  it("treats 4xx (422) as permanent, 429/5xx as transient", () => {
    expect(PERMANENT_ERROR_CODES.has(422)).toBe(true);
    expect(PERMANENT_ERROR_CODES.has(401)).toBe(true);
    expect(PERMANENT_ERROR_CODES.has(429)).toBe(false);
    expect(PERMANENT_ERROR_CODES.has(500)).toBe(false);
  });

  it("returns friendly messages", () => {
    expect(sanitizeSweegoError(401, "x")).toMatch(/authentication/i);
    expect(sanitizeSweegoError(429, "x")).toMatch(/rate limit/i);
  });
});
