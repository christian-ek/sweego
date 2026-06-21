# Sweego Convex Component

[![npm version](https://badge.fury.io/js/@christian-ek%2Fsweego.svg)](https://www.npmjs.com/package/@christian-ek/sweego)
[![Convex Component](https://www.convex.dev/components/badge/christian-ek/sweego)](https://www.convex.dev/components/christian-ek/sweego)

A [Convex component](https://www.convex.dev/components) for sending
**transactional email and SMS** through [Sweego](https://www.sweego.io), with
durable delivery and webhook-based delivery tracking.

Features:

- **Email + SMS** through Sweego's unified `/send` API, plus personalized
  **bulk email** (`/send/bulk/email`).
- **Durable execution** — sends run in a [workpool](https://www.convex.dev/components/workpool)
  and are retried automatically through transient failures (429s, 5xx, network
  blips). Permanent failures (4xx) are recorded without futile retries.
- **Delivery tracking** — verifies Sweego's HMAC-SHA256 webhook signatures and
  maintains per-recipient delivery state (delivered / bounced / opened /
  clicked / complained / unsubscribed; SMS undelivered / stopped / clicked).
- **Templates, attachments, custom headers, List-Unsubscribe, expiry, and
  campaign metadata** — the full send surface.
- **Event callbacks** — register a mutation that runs whenever a delivery event
  arrives.
- **Status, cancellation, and retention cleanup** out of the box.

No `svix` dependency and no Sweego SDK — the component calls the REST API with
`fetch` and verifies signatures with the Web Crypto API.

## Installation

```bash
npm install @christian-ek/sweego
```

Create a [Sweego](https://app.sweego.io) account, verify a sending domain (and
set up an SMS channel if you want SMS), and create an API key. Set it in your
Convex deployment:

```bash
npx convex env set SWEEGO_API_KEY swg_xxxxxxxx
```

Add the component to your app in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import sweego from "@christian-ek/sweego/convex.config";

const app = defineApp();
app.use(sweego);

export default app;
```

## Get started

```ts
// convex/sweego.ts
import { components } from "./_generated/api";
import { Sweego } from "@christian-ek/sweego";
import { internalMutation } from "./_generated/server";

export const sweego = new Sweego(components.sweego, {});

export const sendWelcome = internalMutation({
  handler: async (ctx) => {
    await sweego.sendEmail(ctx, {
      from: "Acme <hello@yourdomain.com>",
      to: "user@example.com",
      subject: "Welcome!",
      text: "Welcome to Acme!", // Sweego requires text (or a template)
      html: "<h1>Welcome to Acme</h1>", // html is supplementary
    });
  },
});
```

`sendEmail` (and `sendSms` / `sendBulkEmail`) can be called from a **mutation or
an action**. It enqueues the message and returns a `MessageId` immediately; the
component delivers it durably in the background.

`from`/`to`/`cc`/`bcc`/`replyTo` accept either `"Name <email>"` strings or
`{ email, name }` objects.

## Sending SMS

SMS goes through the same component. Sweego requires a `campaignType`
(`"transac"` or `"market"`), and a region for each recipient:

```ts
await sweego.sendSms(ctx, {
  to: "+33600000000",
  region: "FR", // ISO-3166 alpha-2; applied to bare-string recipients
  campaignType: "transac",
  senderId: "Acme", // 3–11 chars; required if you have multiple sender IDs
  text: "Your code is 123456",
});
```

You can also pass structured recipients: `to: [{ num: "+1...", region: "US" }]`.

Estimate cost/segments before sending (from an action):

```ts
const estimate = await sweego.estimateSms(ctx, {
  campaign_type: "transac",
  message_txt: "Your code is 123456",
  recipients: [{ num: "+33600000000", region: "FR" }],
});
```

## Templates

Reference a Sweego-hosted template by id and pass `variables` for
`{{ placeholder }}` interpolation:

```ts
await sweego.sendEmail(ctx, {
  from: "Acme <hello@yourdomain.com>",
  to: "user@example.com",
  subject: "Your receipt",
  templateId: "your-template-uuid",
  variables: { name: "Ada", amount: 42 },
});
```

> You cannot combine `templateId` with `html`. On a single `/send`, `variables`
> are only applied for a single recipient — use `sendBulkEmail` for
> per-recipient personalization.

## Bulk personalized email

```ts
await sweego.sendBulkEmail(ctx, {
  from: "Acme <hello@yourdomain.com>",
  subject: "Newsletter",
  templateId: "your-template-uuid",
  recipients: [
    { email: "alice@example.com", variables: { name: "Alice" } },
    { email: "bob@example.com", variables: { name: "Bob" } },
  ],
});
```

Bulk sends require ≥2 recipients and do not support `cc`/`bcc`/`replyTo`.

## Attachments, headers, and more

```ts
await sweego.sendEmail(ctx, {
  from: "Acme <hello@yourdomain.com>",
  to: "user@example.com",
  subject: "Your invoice",
  text: "Your invoice is attached.",
  html: "<p>See attached.</p>",
  attachments: [
    { filename: "invoice.pdf", content: base64Pdf /* base64-encoded bytes */ },
  ],
  headers: { "Ref-1": "643524" }, // omit the X- prefix; max 5 headers
  listUnsub: { method: "one-click", value: "<mailto:unsub@acme.com>,<https://acme.com/u>" },
  expires: "2026-07-26T19:30:00+02:00", // or a delta like "1 day"
  campaignType: "transac",
  campaignTags: ["welcome"],
});
```

> **Attachment size:** attachment bytes are stored inline with the message, so
> the whole message must fit within Convex's ~1 MiB document limit. Keep
> attachments small; host large files elsewhere and link to them.

## Tracking status

`sendEmail`/`sendSms` return a branded `MessageId`. Use it to:

```ts
const status = await sweego.status(ctx, messageId);
// {
//   status: "queued" | "sent" | "failed" | "cancelled",
//   channel, transactionId, errorMessage, creditLeft,
//   deliveries: [
//     { swgUid, recipientKey, status, delivered, bounced, opened, clicked, ... }
//   ],
// }

const full = await sweego.get(ctx, messageId); // full message + deliveries
const cancelled = await sweego.cancel(ctx, messageId); // true if not yet sent
```

A message produces one **delivery** per recipient (Sweego returns one `swg_uid`
per recipient), each tracked independently.

## Listing & searching (admin views)

For an admin "all emails sent" view, the component can query its own message
log (newest first), so you don't have to mirror sends into your own table:

```ts
// Paginated — use with Convex's `usePaginatedQuery`. Optional filters: send
// status, primary campaign tag, and an inclusive creation-time range (ms).
const result = await sweego.list(ctx, {
  paginationOpts, // { numItems, cursor }
  status: "sent", // optional
  tag: "invitation", // optional — matches the first campaignTag
  start,
  end, // optional — creation-time bounds
});
// result.page: [{ messageId, channel, status, subject, recipientCount,
//                 campaignTags, transactionId, errorMessage, createdAt }]

// Full-text search over subject + recipients (relevance-ranked, capped at 50,
// not paginated). Same status / tag / date filters as `list`.
const hits = await sweego.search(ctx, { search: "welcome", status: "sent" });

// Earliest message time (for a date-range picker default), or null.
const { earliest } = await sweego.bounds(ctx);
```

Tag your sends (`campaignTags`) to group them in the log — the `tag` filter
matches the first tag (e.g. by template or campaign).

## Webhooks (delivery events)

Sending alone won't tell you whether a message was delivered, bounced, opened,
or clicked — for that, set up a webhook.

1. Mount an HTTP route in `convex/http.ts`:

   ```ts
   import { httpRouter } from "convex/server";
   import { httpAction } from "./_generated/server";
   import { sweego } from "./sweego";

   const http = httpRouter();
   http.route({
     path: "/webhooks/sweego",
     method: "POST",
     handler: httpAction(async (ctx, req) => sweego.handleSweegoWebhook(ctx, req)),
   });
   export default http;
   ```

   Your endpoint is then `https://<your-deployment>.convex.site/webhooks/sweego`.

2. In the Sweego dashboard, create a webhook pointing at that URL and select the
   email/SMS events you care about.

3. Copy the webhook's **signing secret** and set it in your deployment:

   ```bash
   npx convex env set SWEEGO_WEBHOOK_SECRET <secret>
   ```

The component verifies Sweego's `webhook-id` / `webhook-timestamp` /
`webhook-signature` HMAC-SHA256 signature against the raw request body before
processing anything. Set `webhookToleranceSeconds` in the options to also reject
stale (replayed) requests.

### Reacting to events

Register an `onEvent` mutation that runs whenever a delivery event arrives:

```ts
import { components } from "./_generated/api";
import { internal } from "./_generated/api";
import { Sweego, vOnEventArgs } from "@christian-ek/sweego";
import { internalMutation } from "./_generated/server";

export const sweego = new Sweego(components.sweego, {
  onEvent: internal.sweego.handleEvent,
});

export const handleEvent = internalMutation({
  args: vOnEventArgs, // { messageId, swgUid, event }
  handler: async (ctx, { messageId, swgUid, event }) => {
    // event.eventType e.g. "delivered", "hard_bounce", "email_opened",
    //   "sms_undelivered", ...; event.raw holds the full Sweego payload.
    console.log(messageId, swgUid, event.eventType);
  },
});
```

> With `vOnEventArgs`, `event` is loosely typed. For a fully-typed `event`
> (`SweegoEvent`), define the handler with `sweego.defineEventHandler(async (ctx, { messageId, swgUid, event }) => { ... })`
> instead — it registers an internal mutation with the right argument types.

> No webhooks yet? `sweego.refreshStatus(ctx, messageId)` (from an action) polls
> Sweego's logs and updates delivery state on demand.

## Options

```ts
new Sweego(components.sweego, {
  apiKey,                   // default: process.env.SWEEGO_API_KEY
  webhookSecret,            // default: process.env.SWEEGO_WEBHOOK_SECRET
  provider,                 // default: "sweego"
  testMode,                 // default: false — see below
  initialBackoffMs,         // default: 30000
  retryAttempts,            // default: 5
  webhookToleranceSeconds,  // default: 0 (disabled)
  onEvent,                  // your event-handler mutation reference
});
```

**`testMode`** — when `true`, email sends are submitted with Sweego's `dry-run`
(validated by Sweego but never delivered) and SMS sends use BAT test mode. It is
**off by default**: because `dry-run` produces no real delivery and no webhooks,
you must opt in. You can also set `dryRun: true` (email) or `bat: true` (SMS) on
an individual send.

## Data retention

The component retains messages, deliveries, and raw events. Clean them up on a
schedule with the built-in mutations:

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const crons = cronJobs();
crons.interval(
  "Clean up old Sweego messages",
  { hours: 1 },
  internal.crons.cleanupSweego,
);

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const cleanupSweego = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, components.sweego.lib.cleanupOldMessages, {
      olderThan: ONE_WEEK_MS,
    });
    await ctx.scheduler.runAfter(
      0,
      components.sweego.lib.cleanupAbandonedMessages,
      { olderThan: 4 * ONE_WEEK_MS },
    );
  },
});

export default crons;
```

`cleanupOldMessages` deletes finalized messages (and their deliveries/events)
older than the cutoff (default 7 days); `cleanupAbandonedMessages` clears
never-finalized messages (default 30 days).

## Notes & gotchas

- **Email body:** Sweego requires **`text`** (the plain-text part) *or* a
  **`templateId`**. `html` is supplementary — sending `html` **alone** is
  rejected with `Either 'message-txt' or 'template-id' is required`. The
  component enforces this locally (it throws before sending), so you get a clear
  error instead of a 422. Always include `text` alongside `html`.
- **Auth:** Sweego authenticates with an `Api-Key:` header (not
  `Authorization: Bearer`) — handled for you.
- **Field names:** Sweego's API uses hyphenated keys (`message-html`,
  `template-id`, `campaign-type`, …). The component maps your camelCase options
  to the exact wire format.
- **SMS:** there's no bulk SMS endpoint — multi-recipient SMS goes through one
  `/send` call. `campaignType` is required, and each recipient's `region` must
  match the number's country (e.g. `+46…` → `SE`) or Sweego 422s. SMS
  `variables` are shared across all recipients.
- **Senders must be authorized by Sweego (account-level):** the email `from`
  must be on a domain verified for your API key, and SMS sender IDs must be
  registered — some regions (e.g. Sweden) *require* a verified alphanumeric
  sender ID and reject the default numeric sender, and US/Canada require a
  Toll-Free Number passed as `senderId`. These are dashboard settings; the
  component surfaces Sweego's rejection but can't pre-validate them.
- **Open/click tracking** is enabled per-domain in the Sweego dashboard, not per
  send. Tracking events can be delayed up to ~10 minutes.
- **Rate limiting:** Sweego does not publish API limits, so the component bounds
  throughput via the send workpool's parallelism and retries 429s with backoff
  rather than guessing a fixed rate.
- **Delivery is at-least-once.** Sweego's `/send` exposes no idempotency key, so
  the component never retries once a request has been accepted (only transient
  failures *before* acceptance are retried). In the rare event the process dies
  between Sweego accepting a request and the component recording it, a retry
  could re-send. This window is kept as small as possible.

## License

Apache-2.0
