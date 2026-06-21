# Changelog

## 0.1.0

Initial release.

- Send transactional **email** and **SMS** via Sweego's unified `/send` API.
- Personalized **bulk email** via `/send/bulk/email`.
- **Durable delivery** through a Convex workpool, with automatic retries on
  transient failures and no retries on permanent (4xx) errors.
- **Webhook delivery tracking** with HMAC-SHA256 signature verification (Web
  Crypto) and per-recipient delivery state.
- Support for templates, attachments, custom headers, List-Unsubscribe, message
  expiry, and campaign metadata.
- `onEvent` callback, `status` / `get` / `cancel`, `estimateSms`,
  `refreshStatus`, and retention-cleanup mutations.
