/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const setup = () => convexTest(schema, modules);

const options = {
  apiKey: "test-key",
  provider: "sweego",
  initialBackoffMs: 1,
  retryAttempts: 1,
  testMode: false,
};

describe("enqueueMessage validation", () => {
  it("rejects a message with no body or template", async () => {
    const t = setup();
    await expect(
      t.mutation(api.lib.enqueueMessage, {
        options,
        message: {
          channel: "email",
          bulk: false,
          from: { email: "a@b.com" },
          subject: "s",
          emailRecipients: [{ email: "c@d.com" }],
        },
      }),
    ).rejects.toThrow(/alone is rejected by Sweego/);
  });

  it("rejects an html-only email (Sweego needs text or templateId)", async () => {
    const t = setup();
    await expect(
      t.mutation(api.lib.enqueueMessage, {
        options,
        message: {
          channel: "email",
          bulk: false,
          from: { email: "a@b.com" },
          subject: "s",
          emailRecipients: [{ email: "c@d.com" }],
          html: "<p>hi</p>",
        },
      }),
    ).rejects.toThrow(/alone is rejected by Sweego/);
  });

  it("rejects html + templateId together", async () => {
    const t = setup();
    await expect(
      t.mutation(api.lib.enqueueMessage, {
        options,
        message: {
          channel: "email",
          bulk: false,
          from: { email: "a@b.com" },
          subject: "s",
          emailRecipients: [{ email: "c@d.com" }],
          html: "<p>x</p>",
          templateId: "t1",
        },
      }),
    ).rejects.toThrow(/either html or templateId/);
  });

  it("rejects SMS without a campaignType", async () => {
    const t = setup();
    await expect(
      t.mutation(api.lib.enqueueMessage, {
        options,
        message: {
          channel: "sms",
          bulk: false,
          smsRecipients: [{ num: "+1", region: "US" }],
          text: "hi",
        },
      }),
    ).rejects.toThrow(/campaignType/);
  });
});

describe("handleEvent state machine", () => {
  async function seedDelivery(t: ReturnType<typeof setup>, swgUid: string) {
    return t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        channel: "email",
        provider: "sweego",
        status: "sent",
        bulk: false,
        finalizedAt: Date.now(),
      });
      await ctx.db.insert("deliveries", {
        messageId,
        swgUid,
        recipientKey: "c@d.com",
        channel: "email",
        status: "sent",
        delivered: false,
        bounced: false,
        softBounced: false,
        complained: false,
        unsubscribed: false,
        opened: false,
        clicked: false,
        stopped: false,
        finalizedAt: Number.MAX_SAFE_INTEGER,
      });
      return messageId;
    });
  }

  const readDelivery = (t: ReturnType<typeof setup>, swgUid: string) =>
    t.run(async (ctx) =>
      ctx.db
        .query("deliveries")
        .withIndex("by_swgUid", (q) => q.eq("swgUid", swgUid))
        .unique(),
    );

  it("marks a delivery delivered and records the raw event", async () => {
    const t = setup();
    await seedDelivery(t, "uid1");
    await t.mutation(api.lib.handleEvent, {
      event: { event_type: "delivered", swg_uid: "uid1", channel: "email" },
    });
    const d = await readDelivery(t, "uid1");
    expect(d?.status).toBe("delivered");
    expect(d?.delivered).toBe(true);
    expect(d?.lastEventType).toBe("delivered");

    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_swgUid", (q) => q.eq("swgUid", "uid1"))
        .collect(),
    );
    expect(events.length).toBe(1);
  });

  it("sets the opened flag and upgrades to terminal bounced", async () => {
    const t = setup();
    await seedDelivery(t, "uid2");
    await t.mutation(api.lib.handleEvent, {
      event: { event_type: "email_opened", swg_uid: "uid2" },
    });
    await t.mutation(api.lib.handleEvent, {
      event: { event_type: "hard_bounce", swg_uid: "uid2" },
    });
    const d = await readDelivery(t, "uid2");
    expect(d?.opened).toBe(true);
    expect(d?.status).toBe("bounced");
    expect(d?.bounced).toBe(true);
  });

  it("ignores events for unknown swg_uids but still records them", async () => {
    const t = setup();
    await t.mutation(api.lib.handleEvent, {
      event: { event_type: "delivered", swg_uid: "nope" },
    });
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_swgUid", (q) => q.eq("swgUid", "nope"))
        .collect(),
    );
    expect(events.length).toBe(1);
  });

  it("deduplicates redelivered webhooks by webhook-id", async () => {
    const t = setup();
    await seedDelivery(t, "uid3");
    const event = { event_type: "email_opened", swg_uid: "uid3" };
    await t.mutation(api.lib.handleEvent, { event, webhookId: "wh_1" });
    // Same webhook-id again (a replay/redelivery) must be a no-op.
    await t.mutation(api.lib.handleEvent, { event, webhookId: "wh_1" });
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_swgUid", (q) => q.eq("swgUid", "uid3"))
        .collect(),
    );
    expect(events.length).toBe(1);
  });
});

describe("list / search / bounds", () => {
  async function seedMessage(
    t: ReturnType<typeof setup>,
    subject: string,
    opts: {
      status?: "queued" | "sent" | "failed" | "cancelled";
      tag?: string;
      email?: string;
    } = {},
  ) {
    const { status = "sent", tag, email = "u@x.com" } = opts;
    return t.run(async (ctx) =>
      ctx.db.insert("messages", {
        channel: "email",
        provider: "sweego",
        status,
        bulk: false,
        subject,
        emailRecipients: [{ email }],
        finalizedAt: Date.now(),
        searchText: `${subject} ${email}`.toLowerCase(),
        primaryTag: tag,
        campaignTags: tag ? [tag] : undefined,
      }),
    );
  }

  it("paginates newest-first", async () => {
    const t = setup();
    await seedMessage(t, "s0");
    await seedMessage(t, "s1");
    await seedMessage(t, "s2");

    const first = await t.query(api.lib.list, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page.length).toBe(2);
    expect(first.isDone).toBe(false);
    expect(first.page[0].subject).toBe("s2"); // newest first
    expect(first.page[0].recipientCount).toBe(1);

    const second = await t.query(api.lib.list, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.length).toBe(1);
    expect(second.page[0].subject).toBe("s0");
    expect(second.isDone).toBe(true);
  });

  it("filters by status", async () => {
    const t = setup();
    await seedMessage(t, "ok", { status: "sent" });
    await seedMessage(t, "bad", { status: "failed" });
    const r = await t.query(api.lib.list, {
      paginationOpts: { numItems: 50, cursor: null },
      status: "failed",
    });
    expect(r.page.length).toBe(1);
    expect(r.page[0].subject).toBe("bad");
    expect(r.page[0].status).toBe("failed");
  });

  it("filters by primary tag", async () => {
    const t = setup();
    await seedMessage(t, "invite", { tag: "invitation" });
    await seedMessage(t, "reset", { tag: "resetPassword" });
    const r = await t.query(api.lib.list, {
      paginationOpts: { numItems: 50, cursor: null },
      tag: "invitation",
    });
    expect(r.page.length).toBe(1);
    expect(r.page[0].subject).toBe("invite");
    expect(r.page[0].campaignTags).toEqual(["invitation"]);
  });

  it("searches subject + recipients", async () => {
    const t = setup();
    await seedMessage(t, "Welcome aboard", { email: "alice@acme.com" });
    await seedMessage(t, "Reset link", { email: "bob@acme.com" });

    const bySubject = await t.query(api.lib.search, { search: "welcome" });
    expect(bySubject.page.length).toBe(1);
    expect(bySubject.page[0].subject).toBe("Welcome aboard");

    const byRecipient = await t.query(api.lib.search, { search: "bob" });
    expect(byRecipient.page.length).toBe(1);
    expect(byRecipient.page[0].subject).toBe("Reset link");

    const empty = await t.query(api.lib.search, { search: "  " });
    expect(empty.page.length).toBe(0);
  });

  it("reports the earliest creation time", async () => {
    const t = setup();
    const before = await t.query(api.lib.bounds, {});
    expect(before.earliest).toBeNull();
    await seedMessage(t, "first");
    const after = await t.query(api.lib.bounds, {});
    expect(after.earliest).not.toBeNull();
  });
});
