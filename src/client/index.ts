import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
  internalMutationGeneric,
} from "convex/server";
import { type VString, v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  type ActionCtx,
  type Attachment,
  DEFAULT_PROVIDER,
  type EmailAddress,
  type ListUnsub,
  type MessageInput,
  type MutationCtx,
  parseEmailAddress,
  parseEmailAddresses,
  type QueryCtx,
  type RuntimeConfig,
  type SmsCampaignType,
  type SmsRecipient,
  type SweegoEvent,
  type Variables,
  vSweegoEvent,
} from "../component/shared.js";
import { readWebhookHeaders, verifySweegoSignature } from "./webhook.js";

/* -------------------------------------------------------------------------- */
/*  Re-exports for consumers                                                  */
/* -------------------------------------------------------------------------- */

export type SweegoComponent = ComponentApi;

// A branded id for a message stored in the component.
export type MessageId = string & { __isSweegoMessageId: true };
export const vMessageId = v.string() as VString<MessageId>;

export { vSweegoEvent } from "../component/shared.js";
export type {
  Attachment,
  Channel,
  DeliveryStatus,
  EmailAddress,
  ListUnsub,
  SendStatus,
  SmsCampaignType,
  SmsRecipient,
  SweegoEvent,
  Variables,
} from "../component/shared.js";

// Argument validators for an `onEvent` handler defined in the host app, for use
// directly as a function's `args` — e.g. `internalMutation({ args: vOnEventArgs })`.
// `event` is validated loosely (the component is the only caller and always
// sends a valid {@link SweegoEvent}); use {@link Sweego.defineEventHandler} for a
// fully-typed `event`.
export const vOnEventArgs = {
  messageId: vMessageId,
  swgUid: v.string(),
  event: v.any(),
};

type EventHandlerRef = FunctionReference<
  "mutation",
  FunctionVisibility,
  { messageId: MessageId; swgUid: string; event: SweegoEvent }
>;

/* -------------------------------------------------------------------------- */
/*  Options                                                                   */
/* -------------------------------------------------------------------------- */

export type SweegoOptions = {
  /** Sweego API key. Defaults to `process.env.SWEEGO_API_KEY`. */
  apiKey?: string;
  /**
   * Webhook signing secret (from the Sweego dashboard). Defaults to
   * `process.env.SWEEGO_WEBHOOK_SECRET`. Required only to verify webhooks.
   */
  webhookSecret?: string;
  /** The Sweego provider. Defaults to "sweego". */
  provider?: string;
  /**
   * When true, email sends are submitted with `dry-run` (Sweego validates but
   * does not send) and SMS sends use BAT test mode. Defaults to false.
   */
  testMode?: boolean;
  /** Initial retry backoff in ms for the send workpool. Defaults to 30000. */
  initialBackoffMs?: number;
  /** Max send attempts before giving up. Defaults to 5. */
  retryAttempts?: number;
  /**
   * Reject webhooks whose timestamp differs from now by more than this many
   * seconds (replay protection). Defaults to 300 (5 minutes), per the Standard
   * Webhooks recommendation. Set to 0 to disable the timestamp check (not
   * recommended — webhook-id deduplication still applies either way).
   */
  webhookToleranceSeconds?: number;
  /** A mutation in your app to run after each delivery event. */
  onEvent?: EventHandlerRef | null;
};

type ResolvedConfig = {
  provider: string;
  testMode: boolean;
  initialBackoffMs: number;
  retryAttempts: number;
  webhookToleranceSeconds: number;
};

/* -------------------------------------------------------------------------- */
/*  Send option types                                                         */
/* -------------------------------------------------------------------------- */

type AddressInput = string | EmailAddress;

type CommonEmailOptions = {
  /** Plain-text body. Required unless `templateId` is set. */
  text?: string;
  /**
   * Supplementary HTML body. Sweego rejects an email sent with `html` but no
   * `text`/`templateId` — always pair `html` with `text` (or use a template).
   */
  html?: string;
  templateId?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
  listUnsub?: ListUnsub;
  expires?: string;
  campaignId?: string;
  campaignTags?: string[];
  campaignType?: "market" | "newsletter" | "transac";
  compressStyle?: boolean;
  forceInlineStyle?: boolean;
  dryRun?: boolean;
};

export type SendEmailOptions = CommonEmailOptions & {
  from: AddressInput;
  to: AddressInput | AddressInput[];
  cc?: AddressInput | AddressInput[];
  bcc?: AddressInput | AddressInput[];
  replyTo?: AddressInput;
  subject?: string;
  /** Template variables. Only applied for a single recipient on /send. */
  variables?: Variables;
};

export type BulkEmailRecipient = {
  email: string;
  name?: string;
  variables?: Variables;
};

export type SendBulkEmailOptions = CommonEmailOptions & {
  from: AddressInput;
  subject?: string;
  /** At least 2 recipients; each may carry its own `variables`. */
  recipients: Array<BulkEmailRecipient | string>;
};

export type SendSmsOptions = {
  to: SmsRecipient | SmsRecipient[] | string | string[];
  /** Default ISO region (e.g. "FR") for recipients given as bare strings. */
  region?: string;
  text?: string;
  templateId?: string;
  variables?: Variables;
  /** REQUIRED by Sweego for SMS. */
  campaignType: SmsCampaignType;
  senderId?: string;
  shortenUrls?: boolean;
  shortenWithProtocol?: boolean;
  /** BAT test mode. */
  bat?: boolean;
  campaignId?: string;
};

/* -------------------------------------------------------------------------- */
/*  Client                                                                    */
/* -------------------------------------------------------------------------- */

export class Sweego {
  public readonly config: ResolvedConfig;
  private readonly _apiKey?: string;
  private readonly _webhookSecret?: string;
  public readonly onEvent?: EventHandlerRef | null;

  /**
   * @param component The mounted component, e.g. `components.sweego`.
   * @param options {@link SweegoOptions}.
   */
  constructor(
    public component: SweegoComponent,
    options?: SweegoOptions,
  ) {
    this._apiKey = options?.apiKey;
    this._webhookSecret = options?.webhookSecret;
    this.onEvent = options?.onEvent;
    this.config = {
      provider: options?.provider ?? DEFAULT_PROVIDER,
      testMode: options?.testMode ?? false,
      initialBackoffMs: options?.initialBackoffMs ?? 30000,
      retryAttempts: options?.retryAttempts ?? 5,
      webhookToleranceSeconds: options?.webhookToleranceSeconds ?? 300,
    };
  }

  // Resolved at call time so the client can be constructed at module load.
  private get apiKey(): string {
    const key = this._apiKey ?? process.env.SWEEGO_API_KEY;
    if (!key) {
      throw new Error(
        "Sweego API key is not set. Pass `apiKey` or set SWEEGO_API_KEY.",
      );
    }
    return key;
  }

  private get webhookSecret(): string {
    const secret = this._webhookSecret ?? process.env.SWEEGO_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error(
        "Sweego webhook secret is not set. Pass `webhookSecret` or set SWEEGO_WEBHOOK_SECRET.",
      );
    }
    return secret;
  }

  private async runtimeConfig(): Promise<RuntimeConfig> {
    return {
      apiKey: this.apiKey,
      provider: this.config.provider,
      initialBackoffMs: this.config.initialBackoffMs,
      retryAttempts: this.config.retryAttempts,
      testMode: this.config.testMode,
      onEvent: this.onEvent
        ? { fnHandle: await createFunctionHandle(this.onEvent) }
        : undefined,
    };
  }

  /**
   * Enqueue an email. It is sent durably (with retries) by the component's
   * workpool. Returns the {@link MessageId} you can use to check status,
   * cancel, or correlate webhook events.
   */
  async sendEmail(
    ctx: MutationCtx | ActionCtx,
    options: SendEmailOptions,
  ): Promise<MessageId> {
    const message: MessageInput = {
      channel: "email",
      bulk: false,
      from: parseEmailAddress(options.from),
      emailRecipients: parseEmailAddresses(options.to).map((a) => ({
        email: a.email,
        name: a.name,
      })),
      cc: options.cc ? parseEmailAddresses(options.cc) : undefined,
      bcc: options.bcc ? parseEmailAddresses(options.bcc) : undefined,
      replyTo: options.replyTo ? parseEmailAddress(options.replyTo) : undefined,
      subject: options.subject,
      html: options.html,
      text: options.text,
      templateId: options.templateId,
      variables: options.variables,
      attachments: options.attachments,
      headers: options.headers,
      listUnsub: options.listUnsub,
      expires: options.expires,
      campaignId: options.campaignId,
      campaignTags: options.campaignTags,
      campaignType: options.campaignType,
      compressStyle: options.compressStyle,
      forceInlineStyle: options.forceInlineStyle,
      dryRun: options.dryRun ?? (this.config.testMode ? true : undefined),
    };
    return this.enqueue(ctx, message);
  }

  /**
   * Enqueue a personalized bulk email (Sweego's `/send/bulk/email`). Each
   * recipient may carry its own `variables`. No cc/bcc/replyTo support.
   */
  async sendBulkEmail(
    ctx: MutationCtx | ActionCtx,
    options: SendBulkEmailOptions,
  ): Promise<MessageId> {
    const message: MessageInput = {
      channel: "email",
      bulk: true,
      from: parseEmailAddress(options.from),
      emailRecipients: options.recipients.map((r) =>
        typeof r === "string"
          ? { email: r }
          : { email: r.email, name: r.name, variables: r.variables },
      ),
      subject: options.subject,
      html: options.html,
      text: options.text,
      templateId: options.templateId,
      attachments: options.attachments,
      headers: options.headers,
      listUnsub: options.listUnsub,
      expires: options.expires,
      campaignId: options.campaignId,
      campaignTags: options.campaignTags,
      campaignType: options.campaignType,
      compressStyle: options.compressStyle,
      forceInlineStyle: options.forceInlineStyle,
      dryRun: options.dryRun ?? (this.config.testMode ? true : undefined),
    };
    return this.enqueue(ctx, message);
  }

  /** Enqueue an SMS (Sweego's `/send` with `channel: "sms"`). */
  async sendSms(
    ctx: MutationCtx | ActionCtx,
    options: SendSmsOptions,
  ): Promise<MessageId> {
    const message: MessageInput = {
      channel: "sms",
      bulk: false,
      smsRecipients: normalizeSmsRecipients(options.to, options.region),
      text: options.text,
      templateId: options.templateId,
      variables: options.variables,
      campaignType: options.campaignType,
      senderId: options.senderId,
      shortenUrls: options.shortenUrls,
      shortenWithProtocol: options.shortenWithProtocol,
      bat: options.bat ?? (this.config.testMode ? true : undefined),
      campaignId: options.campaignId,
    };
    return this.enqueue(ctx, message);
  }

  private async enqueue(
    ctx: MutationCtx | ActionCtx,
    message: MessageInput,
  ): Promise<MessageId> {
    const options = await this.runtimeConfig();
    const id = await ctx.runMutation(this.component.lib.enqueueMessage, {
      options,
      message,
    });
    return id as MessageId;
  }

  /** Aggregate status of a message plus per-recipient delivery state. */
  async status(ctx: QueryCtx | MutationCtx | ActionCtx, messageId: MessageId) {
    return ctx.runQuery(this.component.lib.getStatus, { messageId });
  }

  /** The full stored message plus its deliveries. */
  async get(ctx: QueryCtx | MutationCtx | ActionCtx, messageId: MessageId) {
    return ctx.runQuery(this.component.lib.get, { messageId });
  }

  /**
   * Cancel a message if it has not yet been handed to Sweego. Returns true if
   * it was cancelled, false if it had already been sent.
   */
  async cancel(
    ctx: MutationCtx | ActionCtx,
    messageId: MessageId,
  ): Promise<boolean> {
    return ctx.runMutation(this.component.lib.cancel, { messageId });
  }

  /** Estimate the cost/segments of an SMS send (Sweego `/sms/estimate`). */
  async estimateSms(
    ctx: ActionCtx,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return ctx.runAction(this.component.lib.estimateSms, {
      apiKey: this.apiKey,
      body,
    });
  }

  /**
   * Poll Sweego's logs to refresh delivery status without webhooks. Returns the
   * number of deliveries updated. Prefer webhooks where possible.
   */
  async refreshStatus(ctx: ActionCtx, messageId: MessageId): Promise<number> {
    return ctx.runAction(this.component.lib.refreshStatus, {
      apiKey: this.apiKey,
      messageId,
    });
  }

  /**
   * Verify and handle a Sweego webhook. Mount this on an HTTP route. Verifies
   * the HMAC signature against the raw body, then updates delivery state and
   * dispatches your `onEvent` handler.
   */
  async handleSweegoWebhook(
    ctx: MutationCtx | ActionCtx,
    request: Request,
  ): Promise<Response> {
    const secret = this.webhookSecret;
    const rawBody = await request.text();
    const { id, timestamp, signature } = readWebhookHeaders(request.headers);

    const valid = await verifySweegoSignature({
      secret,
      id: id ?? "",
      timestamp: timestamp ?? "",
      body: rawBody,
      signatureHeader: signature ?? "",
      toleranceSeconds: this.config.webhookToleranceSeconds,
    });
    if (!valid) {
      return new Response("Invalid webhook signature", { status: 401 });
    }

    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      // Acknowledge so Sweego doesn't retry an unparseable body forever.
      return new Response("Invalid JSON body", { status: 200 });
    }

    // Pass the webhook-id so the component can deduplicate redeliveries/replays.
    await ctx.runMutation(this.component.lib.handleEvent, {
      event,
      webhookId: id ?? undefined,
    });
    return new Response(null, { status: 200 });
  }

  /**
   * Helper to define your `onEvent` mutation with the right argument validator.
   * Equivalent to declaring an `internalMutation` with {@link vOnEventArgs}.
   */
  defineEventHandler<DataModel extends GenericDataModel>(
    handler: (
      ctx: GenericMutationCtx<DataModel>,
      args: { messageId: MessageId; swgUid: string; event: SweegoEvent },
    ) => Promise<void>,
  ) {
    return internalMutationGeneric({
      args: {
        messageId: vMessageId,
        swgUid: v.string(),
        event: vSweegoEvent,
      },
      handler,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalizeRegion(region: string): string {
  const up = region.trim().toUpperCase();
  // Sweego requires uppercase ISO-3166 alpha-2 codes (or the literal "OTHER").
  if (up !== "OTHER" && !/^[A-Z]{2}$/.test(up)) {
    throw new Error(
      `Invalid SMS region '${region}'. Expected an uppercase ISO-3166 alpha-2 code (e.g. 'FR') or 'OTHER'.`,
    );
  }
  return up;
}

function normalizeSmsRecipients(
  to: SmsRecipient | SmsRecipient[] | string | string[],
  defaultRegion?: string,
): SmsRecipient[] {
  const list = Array.isArray(to) ? to : [to];
  return list.map((r) => {
    if (typeof r === "string") {
      if (!defaultRegion) {
        throw new Error(
          "SMS recipients given as strings require a `region` option (e.g. region: 'FR').",
        );
      }
      return { num: r, region: normalizeRegion(defaultRegion) };
    }
    return { num: r.num, region: normalizeRegion(r.region) };
  });
}
