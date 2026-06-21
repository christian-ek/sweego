import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  normalizeEventType,
  parseEmailAddress,
  parseEmailAddresses,
} from "./shared.js";

describe("classifyEvent", () => {
  it("classifies email events regardless of hyphen/underscore casing", () => {
    expect(classifyEvent("email_sent")).toBe("sent");
    expect(classifyEvent("delivered")).toBe("delivered");
    expect(classifyEvent("soft-bounce")).toBe("soft_bounce");
    expect(classifyEvent("hard_bounce")).toBe("hard_bounce");
    expect(classifyEvent("complaint")).toBe("complaint");
    expect(classifyEvent("list_unsub")).toBe("unsub");
    expect(classifyEvent("email_opened")).toBe("open");
    expect(classifyEvent("email_clicked")).toBe("click");
    expect(classifyEvent("email_inbound")).toBe("inbound");
  });

  it("classifies SMS events including the stop/sms_stop variants", () => {
    expect(classifyEvent("sms_sent")).toBe("sms_sent");
    expect(classifyEvent("sms_undelivered")).toBe("sms_undelivered");
    expect(classifyEvent("sms_stop")).toBe("sms_stop");
    expect(classifyEvent("stop")).toBe("sms_stop");
    expect(classifyEvent("sms_clicked")).toBe("sms_click");
  });

  it("returns unknown for unrecognized strings", () => {
    expect(classifyEvent("totally_made_up")).toBe("unknown");
  });

  it("normalizes case and hyphens", () => {
    expect(normalizeEventType("Soft-Bounce")).toBe("soft_bounce");
  });
});

describe("parseEmailAddress", () => {
  it('parses "Name <email>"', () => {
    expect(parseEmailAddress("Acme <hi@acme.com>")).toEqual({
      email: "hi@acme.com",
      name: "Acme",
    });
  });

  it("parses a bare email", () => {
    expect(parseEmailAddress("hi@acme.com")).toEqual({ email: "hi@acme.com" });
  });

  it("passes structured addresses through", () => {
    expect(parseEmailAddress({ email: "x@y.com", name: "X" })).toEqual({
      email: "x@y.com",
      name: "X",
    });
  });

  it("parses arrays and strips quotes from names", () => {
    expect(parseEmailAddresses(['"Cara" <c@d.com>', "a@b.com"])).toEqual([
      { email: "c@d.com", name: "Cara" },
      { email: "a@b.com" },
    ]);
  });
});
