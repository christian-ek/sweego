import { useAction, useQuery } from "convex/react";
import { type FormEvent, useState } from "react";
import { api } from "../convex/_generated/api";
import "./index.css";

type Banner = { kind: "ok" | "err"; text: string } | null;

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-amber-100 text-amber-700",
  sent: "bg-sky-100 text-sky-700",
  delivered: "bg-emerald-100 text-emerald-700",
  bounced: "bg-rose-100 text-rose-700",
  undelivered: "bg-rose-100 text-rose-700",
  stopped: "bg-rose-100 text-rose-700",
  soft_bounced: "bg-orange-100 text-orange-700",
  failed: "bg-rose-100 text-rose-700",
  cancelled: "bg-zinc-200 text-zinc-600",
  pending: "bg-zinc-100 text-zinc-500",
};

function Pill({ value }: { value: string | null }) {
  const cls = STATUS_STYLES[value ?? ""] ?? "bg-zinc-100 text-zinc-500";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {value ?? "…"}
    </span>
  );
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] ${
        on ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-400"
      }`}
    >
      {label}
    </span>
  );
}

const inputCls =
  "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";
const labelCls = "mb-1 block text-sm font-medium text-zinc-700";

export function App() {
  const sendEmail = useAction(api.example.sendEmail);
  const sendSms = useAction(api.example.sendSms);
  const recent = useQuery(api.example.listRecent);

  const [banner, setBanner] = useState<Banner>(null);
  const [busy, setBusy] = useState(false);

  // Optional API key (bring-your-own-key). Persisted in localStorage; sent only
  // to your own Convex deployment. Leave blank to use the server's key.
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem("sweego_api_key") ?? "",
  );
  const [showKey, setShowKey] = useState(false);

  // Email form
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("Hello from Sweego + Convex");
  // Sweego requires message-txt (or a template); html is supplementary.
  const [text, setText] = useState("It works! Sent via the Sweego component.");
  const [html, setHtml] = useState("<h1>It works!</h1><p>Sent via Sweego.</p>");

  // SMS form
  const [smsTo, setSmsTo] = useState("");
  const [region, setRegion] = useState("FR");
  const [smsText, setSmsText] = useState("Your code is 123456");
  const [senderId, setSenderId] = useState("");
  const [campaignType, setCampaignType] = useState<"transac" | "market">(
    "transac",
  );

  async function run(fn: () => Promise<string>, label: string) {
    setBusy(true);
    setBanner(null);
    try {
      const id = await fn();
      setBanner({ kind: "ok", text: `${label} queued — ${id}` });
    } catch (err) {
      setBanner({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  const key = apiKey || undefined;

  const onSendEmail = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () => sendEmail({ from, to, subject, text, html, apiKey: key }),
      "Email",
    );
  };

  const onSendSms = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        sendSms({
          to: smsTo,
          region,
          text: smsText,
          campaignType,
          senderId: senderId || undefined,
          apiKey: key,
        }),
      "SMS",
    );
  };

  const saveKey = () => {
    localStorage.setItem("sweego_api_key", apiKey);
    setBanner({ kind: "ok", text: "API key saved in this browser." });
  };
  const clearKey = () => {
    setApiKey("");
    localStorage.removeItem("sweego_api_key");
  };

  return (
    <div className="min-h-screen w-full bg-zinc-50 p-4 text-zinc-900">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 text-center">
          <h1 className="text-3xl font-bold">Sweego × Convex</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Send email &amp; SMS through the{" "}
            <code className="rounded bg-zinc-200 px-1">@christian-ek/sweego</code>{" "}
            component. Delivery status below updates live from webhooks.
          </p>
        </header>

        {banner && (
          <div
            className={`mb-4 rounded-md border p-3 text-sm ${
              banner.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
            }`}
          >
            {banner.text}
          </div>
        )}

        {/* API key (optional, bring-your-own) */}
        <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium text-zinc-700">
              Sweego API key{" "}
              <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="text-xs text-indigo-600 hover:underline"
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          <div className="flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="swg_…  (blank → use the server's SWEEGO_API_KEY)"
              className={inputCls}
            />
            <button
              type="button"
              onClick={saveKey}
              className="rounded-md bg-zinc-800 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Save
            </button>
            <button
              type="button"
              onClick={clearKey}
              className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-200"
            >
              Clear
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Sent only to your own Convex deployment, never to a third party.
            Leave blank to use the key configured server-side.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Email */}
          <form
            onSubmit={onSendEmail}
            className="space-y-3 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
          >
            <h2 className="text-lg font-semibold">Send email</h2>
            <div>
              <label className={labelCls}>From</label>
              <input
                className={inputCls}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="Acme <hi@yourdomain.com>"
              />
            </div>
            <div>
              <label className={labelCls}>To</label>
              <input
                className={inputCls}
                type="email"
                required
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className={labelCls}>Subject</label>
              <input
                className={inputCls}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls}>
                Text <span className="font-normal text-zinc-400">(required by Sweego)</span>
              </label>
              <textarea
                className={`${inputCls} h-16`}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls}>
                HTML <span className="font-normal text-zinc-400">(optional)</span>
              </label>
              <textarea
                className={`${inputCls} h-20 font-mono`}
                value={html}
                onChange={(e) => setHtml(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? "…" : "Send email"}
            </button>
          </form>

          {/* SMS */}
          <form
            onSubmit={onSendSms}
            className="space-y-3 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
          >
            <h2 className="text-lg font-semibold">Send SMS</h2>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelCls}>To</label>
                <input
                  className={inputCls}
                  required
                  value={smsTo}
                  onChange={(e) => setSmsTo(e.target.value)}
                  placeholder="+33600000000"
                />
              </div>
              <div>
                <label className={labelCls}>Region</label>
                <input
                  className={inputCls}
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="FR"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Campaign type</label>
                <select
                  className={inputCls}
                  value={campaignType}
                  onChange={(e) =>
                    setCampaignType(e.target.value as "transac" | "market")
                  }
                >
                  <option value="transac">transac</option>
                  <option value="market">market</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Sender ID (optional)</label>
                <input
                  className={inputCls}
                  value={senderId}
                  onChange={(e) => setSenderId(e.target.value)}
                  placeholder="Acme"
                />
              </div>
            </div>
            <div>
              <label className={labelCls}>Message</label>
              <textarea
                className={`${inputCls} h-24`}
                value={smsText}
                onChange={(e) => setSmsText(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? "…" : "Send SMS"}
            </button>
          </form>
        </div>

        {/* Live list */}
        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">Recent messages</h2>
          {recent === undefined ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Nothing sent yet. Send something above.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {recent.map((m) => (
                <li key={m.messageId} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-xs text-zinc-400">
                      {m.channel === "sms" ? "✉ sms" : "✉ email"}
                    </span>
                    <span className="flex-1 truncate">{m.label}</span>
                    <Pill value={m.status} />
                    {m.deliveries.length > 0 && (
                      <span className="flex items-center gap-1">
                        {m.deliveries.map((d) => (
                          <span
                            key={d.recipientKey}
                            className="flex items-center gap-1"
                            title={d.recipientKey}
                          >
                            <Pill value={d.status} />
                            <Flag on={d.opened} label="open" />
                            <Flag on={d.clicked} label="click" />
                            {d.bounced && <Flag on label="bounce" />}
                            {d.complained && <Flag on label="spam" />}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  {m.status === "failed" && m.errorMessage && (
                    <p className="mt-1 text-xs text-rose-600">
                      {m.errorMessage}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-zinc-400">
            The example client runs with <code>testMode: true</code> (Sweego
            dry-run, nothing actually sends). Set it to <code>false</code> in{" "}
            <code>convex/example.ts</code> and configure a webhook to see live
            delivery/open/click updates.
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
