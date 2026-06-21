# Sweego component example

A runnable Convex app that mounts `@christian-ek/sweego` and demonstrates
sending email + SMS, tracking delivery via webhooks, and cleanup crons — plus a
small Vite + React frontend to drive it.

```
example/
├── convex/        # the backend: mounts the component, send/status functions,
│                  #   webhook route (http.ts), onEvent handler, cleanup crons
├── src/           # a Vite + React + Tailwind demo UI
└── index.html
```

## Run it

From the **repo root** (the example shares the root's dependencies):

```bash
npm install
npx convex dev            # pushes the backend to a dev deployment, watches for changes
```

Set your Sweego credentials in the deployment:

```bash
npx convex env set SWEEGO_API_KEY swg_xxx
npx convex env set SWEEGO_WEBHOOK_SECRET <secret-from-dashboard>   # for webhooks
```

### Backend only

Call the demo functions from the Convex dashboard's function runner (or
`npx convex run`), e.g.:

- `example:sendTestEmail` — `{ "from": "you@yourdomain.com", "to": "user@example.com" }`
- `example:sendTestSms` — `{ "to": "+33600000000", "region": "FR" }`
- `example:checkStatus` — `{ "messageId": "<id returned above>" }`

### With the frontend

Point the frontend at your deployment, then start it (in a second terminal,
while `npx convex dev` runs):

```bash
echo "VITE_CONVEX_URL=$(npx convex env get CONVEX_URL 2>/dev/null || echo https://<your-deployment>.convex.cloud)" > example/.env.local
npm run dev:frontend      # vite dev server
```

The UI has an optional **API-key field**, a **Send email** form, a **Send SMS**
form, and a **live message list** whose delivery status (delivered / bounced /
opened / clicked) updates in real time as webhooks arrive.

You can supply the Sweego API key two ways:

- **Server-side (recommended for a private demo):** leave the UI field blank;
  the component reads `SWEEGO_API_KEY` from the deployment. The key never
  touches the browser.
- **In the UI (bring-your-own-key, like a publicly hosted demo):** paste a key
  into the field — it's stored in `localStorage` and passed with each send.

> If you host this demo publicly, do **not** set `SWEEGO_API_KEY` on the
> deployment — otherwise anyone calling the public action sends with your key.
> For a public demo, rely on the pasted key only.

> The client is created with `testMode: true`, so email is submitted with
> Sweego's `dry-run` (validated, not delivered). Set `testMode: false` in
> `convex/example.ts` and configure a webhook to see real delivery updates.

## Webhook

Create a webhook in the Sweego dashboard pointing at
`https://<your-deployment>.convex.site/webhooks/sweego`, then put its signing
secret in `SWEEGO_WEBHOOK_SECRET`.
