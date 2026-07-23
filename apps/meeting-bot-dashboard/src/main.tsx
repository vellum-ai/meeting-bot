/**
 * Meeting Bot dashboard app.
 *
 * A compiled (v2) React app served in the workspace panel. The host build maps
 * `react` / `react-dom` onto `preact/compat`, so this is ordinary React. It
 * talks to the plugin's routes under `/x/plugins/meeting-bot/`.
 *
 * Two views, routed by local state (the panel iframe is sandboxed, so no
 * URL/hash routing): the home view (Configuration + Meeting history) and a
 * dedicated per-meeting page opened by clicking a history row.
 *
 * The Configuration card shows the whole plugin config. A few fields are
 * editable (voice mode, provider, region); the rest are shown read-only.
 * Meeting history is filtered to the currently configured provider and
 * paginated.
 */

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const BASE = "/x/plugins/meeting-bot";

/** History rows shown per page. */
const PAGE_SIZE = 10;

/**
 * All of the app's styling. Kept here rather than in index.html so the HTML
 * stays a bare mount-point skeleton; rendered once as a <style> tag by App.
 */
const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: Canvas;
    color: CanvasText;
  }
  .app { max-width: 820px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 12px; }
  .h2row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin: 32px 0 12px; flex-wrap: wrap;
  }
  .h2row h2 { margin: 0; }
  .joinform { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .joinform input {
    font: inherit; padding: 6px 8px; border-radius: 6px; min-width: 280px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: transparent; color: inherit;
  }
  .joinnote { font-size: 12px; opacity: 0.8; }
  .joinnote.error { color: color-mix(in srgb, red 70%, CanvasText); opacity: 1; }
  .sub { opacity: 0.7; margin: 0 0 8px; }
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 10px;
    padding: 16px 18px;
  }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .row label { flex: 1; }
  select { font: inherit; padding: 6px 8px; border-radius: 6px; }
  button {
    font: inherit; padding: 6px 12px; border-radius: 6px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: transparent; color: inherit; cursor: pointer;
  }
  button:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }
  button:disabled { opacity: 0.4; cursor: default; }
  a { color: LinkText; }
  .field-status { font-size: 12px; margin-right: 8px; }
  .field-saving { opacity: 0.6; }
  .field-saved { color: color-mix(in srgb, green 70%, CanvasText); }
  .field-error { color: color-mix(in srgb, red 70%, CanvasText); }
  .provider-note { font-size: 12px; opacity: 0.75; padding-top: 0; }
  input:disabled, select:disabled { opacity: 0.5; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td {
    text-align: left; padding: 8px 10px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    vertical-align: top;
  }
  th { font-weight: 600; opacity: 0.7; }
  tbody tr.clickable { cursor: pointer; }
  tbody tr.clickable:hover { background: color-mix(in srgb, CanvasText 6%, transparent); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .url { word-break: break-all; }
  .empty { opacity: 0.6; padding: 16px 2px; }
  .history-status { font-size: 12px; white-space: nowrap; }
  .history-joined, .history-active { color: color-mix(in srgb, green 70%, CanvasText); }
  .history-failed { color: color-mix(in srgb, red 70%, CanvasText); }
  .history-joining, .history-left { opacity: 0.75; }
  .history-detail { font-size: 11px; opacity: 0.7; word-break: break-word; max-width: 260px; }
  .pager {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 10px; padding-top: 10px; font-size: 12px;
  }
  .botlog {
    margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; line-height: 1.45; white-space: pre-wrap;
    word-break: break-word; max-height: 420px; overflow: auto;
  }
  .pager .count { opacity: 0.7; }
  .back { margin-bottom: 14px; }
  .readonly {
    margin-top: 16px; padding-top: 12px;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  .readonly-title { font-size: 13px; font-weight: 600; opacity: 0.7; margin-bottom: 6px; }
  dl { margin: 0; }
  .dl-row { display: flex; gap: 12px; padding: 5px 0; }
  dt { flex: 0 0 160px; opacity: 0.7; }
  dd { margin: 0; word-break: break-all; }
`;

/**
 * Fetch through the host bridge when the app runs inside the Vellum workspace
 * panel: `window.vellum.fetch` reaches the plugin routes with the right origin
 * and auth. Falls back to the global `fetch` (e.g. when opened standalone).
 */
function vfetch(url: string, options?: RequestInit): Promise<Response> {
  const fetcher = (window as unknown as { vellum?: { fetch?: typeof fetch } })
    .vellum?.fetch ?? fetch;
  return fetcher(url, options);
}

const PROVIDERS = ["recall", "vellum"] as const;
type Provider = (typeof PROVIDERS)[number];

const REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-central-1",
  "ap-northeast-1",
] as const;
type Region = (typeof REGIONS)[number];

interface ConfigView {
  useVoiceMode: boolean;
  provider: Provider;
  region: Region;
  publicWsUrl?: string;
  listenPort?: number;
  transcript?: { provider?: string; languageCode?: string; mode?: string };
}

interface Meeting {
  botId: string;
  meetingUrl: string;
  conversationId: string | null;
  conversationTitle?: string;
  startedAt: number;
  updatedAt?: number;
  provider?: string;
  status?: string;
  detail?: string;
}

function formatTime(ms: number | undefined): string {
  if (!ms) return "-";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/**
 * Human label per history status. "joining" is deliberately shown as an
 * attempt: the entry exists from the moment a join is requested, before the
 * bot is confirmed in the call.
 */
function statusLabel(m: Meeting): string {
  switch (m.status) {
    case "joining":
      return "join attempt";
    case "joined":
      return "joined";
    case "failed":
      return "failed";
    case "left":
      return "left";
    case "active":
      return "active";
    default:
      return "-";
  }
}

/**
 * Best-effort URL for the assistant's conversation page. The panel iframe is
 * sandboxed without a navigation bridge, so the link opens in a new tab; the
 * host origin is recovered from document.referrer when available.
 */
function conversationHref(id: string): string {
  const path = `/assistant/conversations/${id}`;
  try {
    if (document.referrer) return new URL(path, document.referrer).toString();
  } catch {
    // fall through to the relative path
  }
  return path;
}

/** Link text for a conversation: its title, else a shortened id. */
function conversationLabel(m: Meeting): string {
  if (m.conversationTitle) return m.conversationTitle;
  return m.conversationId ? `${m.conversationId.slice(0, 8)}…` : "-";
}

function ConversationLink({ meeting }: { meeting: Meeting }) {
  if (!meeting.conversationId) return <>-</>;
  return (
    <a
      href={conversationHref(meeting.conversationId)}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
    >
      {conversationLabel(meeting)}
    </a>
  );
}

function StatusCell({ meeting }: { meeting: Meeting }) {
  return (
    <>
      <span className={`history-status history-${meeting.status || "unknown"}`}>
        {statusLabel(meeting)}
      </span>
      {meeting.status === "failed" && meeting.detail ? (
        <div className="history-detail">{meeting.detail}</div>
      ) : null}
    </>
  );
}

/** Per-field save state: which field is in flight, and the last outcome. */
type FieldState = "idle" | "saving" | "saved" | "error";

function Configuration({
  config,
  setConfig,
}: {
  config: ConfigView | null;
  setConfig: (c: ConfigView) => void;
}) {
  const [fieldState, setFieldState] = useState<Record<string, FieldState>>({});
  const [providerNote, setProviderNote] = useState("");

  function setField(field: string, state: FieldState) {
    setFieldState((prev) => ({ ...prev, [field]: state }));
    if (state === "saved" || state === "error") {
      setTimeout(() => {
        setFieldState((prev) =>
          prev[field] === state ? { ...prev, [field]: "idle" } : prev,
        );
      }, 2500);
    }
  }

  /**
   * Every setting saves on change: PATCH the single edited field, keep the
   * input optimistic while in flight, and reconcile with the server's view
   * (or roll back on failure).
   */
  async function saveField(
    field: "useVoiceMode" | "region",
    value: boolean | string,
  ) {
    if (!config) return;
    const previous = config;
    setConfig({ ...config, [field]: value });
    setField(field, "saving");
    try {
      const res = await vfetch(`${BASE}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) {
        setConfig(await res.json());
        setField(field, "saved");
      } else {
        setConfig(previous);
        setField(field, "error");
      }
    } catch {
      setConfig(previous);
      setField(field, "error");
    }
  }

  // The provider switch goes through its own route: it tears down the old
  // provider runtime and starts the new one before responding, so the busy
  // state can last a few seconds. Selecting the active provider again
  // bounces its runtime.
  async function switchProvider(provider: Provider) {
    if (!config) return;
    const previous = config;
    setConfig({ ...config, provider });
    setField("provider", "saving");
    setProviderNote("");
    try {
      const res = await vfetch(`${BASE}/provider`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (res.ok) {
        const body = await res.json();
        setConfig(body);
        setField("provider", "saved");
        setProviderNote(body.note || "");
        setTimeout(() => setProviderNote(""), 5000);
      } else {
        setConfig(previous);
        setField("provider", "error");
      }
    } catch {
      setConfig(previous);
      setField("provider", "error");
    }
  }

  function fieldBadge(field: string) {
    const state = fieldState[field] ?? "idle";
    if (state === "idle") return null;
    const text =
      state === "saving" ? "Saving..." : state === "saved" ? "Saved" : "Failed";
    return <span className={`field-status field-${state}`}>{text}</span>;
  }

  const busy = (field: string) => fieldState[field] === "saving";

  /** Rows of read-only config shown below the editable fields. */
  function readOnlyRows(c: ConfigView): Array<[string, string]> {
    return [
      ["Public WS URL", c.publicWsUrl || "(not set)"],
      ["Listen port", c.listenPort != null ? String(c.listenPort) : "-"],
      ["Transcript mode", c.transcript?.mode || "-"],
    ];
  }

  return (
    <section>
      <h2>Configuration</h2>
      <div className="card">
        {config === null ? (
          <div className="empty">Loading...</div>
        ) : (
          <>
            <div className="row">
              <label htmlFor="useVoiceMode">Use Voice Mode</label>
              {fieldBadge("useVoiceMode")}
              <input
                id="useVoiceMode"
                type="checkbox"
                checked={config.useVoiceMode}
                disabled={busy("useVoiceMode")}
                onChange={(e) =>
                  void saveField("useVoiceMode", e.target.checked)
                }
              />
            </div>
            <div className="row">
              <label htmlFor="provider">Provider</label>
              {fieldBadge("provider")}
              <select
                id="provider"
                value={config.provider}
                disabled={busy("provider")}
                onChange={(e) => void switchProvider(e.target.value as Provider)}
              >
                <option value="recall">Recall</option>
                <option value="vellum">Vellum</option>
              </select>
            </div>
            {providerNote ? (
              <div className="row provider-note">{providerNote}</div>
            ) : null}
            <div className="row">
              <label htmlFor="region">Region</label>
              {fieldBadge("region")}
              <select
                id="region"
                value={config.region}
                disabled={busy("region")}
                onChange={(e) => void saveField("region", e.target.value)}
              >
                {REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div className="readonly">
              <div className="readonly-title">Other</div>
              <dl>
                {readOnlyRows(config).map(([label, value]) => (
                  <div className="dl-row" key={label}>
                    <dt>{label}</dt>
                    <dd className="mono">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function JoinForm({ onJoined }: { onJoined: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const submit = async () => {
    const meetingUrl = url.trim();
    if (!meetingUrl || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await vfetch(`${BASE}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meetingUrl }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        note?: string;
        error?: string;
      };
      if (res.ok) {
        setNote({ kind: "ok", text: body.note ?? "Join started." });
        setUrl("");
        onJoined();
      } else {
        setNote({ kind: "error", text: body.error ?? `Join failed (${res.status}).` });
      }
    } catch {
      setNote({ kind: "error", text: "Join request failed; is the daemon running?" });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}>Join</button>
    );
  }

  return (
    <div className="joinform">
      <input
        type="text"
        placeholder="Paste a meeting link (https://meet.google.com/...)"
        value={url}
        onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        autoFocus
      />
      <button disabled={busy || url.trim() === ""} onClick={() => void submit()}>
        {busy ? "Joining..." : "Join"}
      </button>
      <button
        disabled={busy}
        onClick={() => {
          setOpen(false);
          setUrl("");
          setNote(null);
        }}
      >
        Cancel
      </button>
      {note ? (
        <span className={note.kind === "error" ? "joinnote error" : "joinnote"}>
          {note.text}
        </span>
      ) : null}
    </div>
  );
}

function MeetingHistory({
  provider,
  meetings,
  onSelect,
  onRefresh,
}: {
  provider: Provider | null;
  meetings: Meeting[] | null;
  onSelect: (m: Meeting) => void;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState(0);

  // History is scoped to the provider currently configured; entries
  // recorded before providers existed count as recall.
  const filtered = (meetings ?? []).filter(
    (m) => provider === null || (m.provider ?? "recall") === provider,
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const rows = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  return (
    <section>
      <div className="h2row">
        <h2>Meeting history</h2>
        <JoinForm onJoined={onRefresh} />
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Meeting</th>
              <th>Status</th>
              <th>Conversation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.botId}
                className="clickable"
                onClick={() => onSelect(m)}
              >
                <td>{formatTime(m.startedAt)}</td>
                <td className="url">{m.meetingUrl || "-"}</td>
                <td>
                  <StatusCell meeting={m} />
                </td>
                <td>
                  <ConversationLink meeting={m} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {meetings !== null && filtered.length === 0 ? (
          <div className="empty">
            No meetings recorded yet
            {provider ? ` for the ${provider} provider` : ""}.
          </div>
        ) : null}
        {filtered.length > PAGE_SIZE ? (
          <div className="pager">
            <span className="count">
              {filtered.length} meetings, page {current + 1} of {pageCount}
            </span>
            <button
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </button>
            <button
              disabled={current >= pageCount - 1}
              onClick={() => setPage(current + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Dedicated page for one meeting, opened by clicking its history row. */
function MeetingDetail({
  meeting,
  onBack,
}: {
  meeting: Meeting;
  onBack: () => void;
}) {
  // The bot log captured for this meeting (data/meets/<id>/bot.log),
  // written by the runtime on join failure and at leave. null = loading,
  // "" = confirmed absent.
  const [log, setLog] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    vfetch(`${BASE}/meeting-log?botId=${encodeURIComponent(meeting.botId)}`)
      .then(async (r) => {
        if (cancelled) return;
        setLog(r.ok ? await r.text() : "");
      })
      .catch(() => {
        if (!cancelled) setLog("");
      });
    return () => {
      cancelled = true;
    };
  }, [meeting.botId]);

  const facts: Array<[string, React.ReactNode]> = [
    ["Meeting URL", <span className="url">{meeting.meetingUrl || "-"}</span>],
    ["Status", <StatusCell meeting={meeting} />],
    ["Provider", meeting.provider ?? "recall"],
    ["Started", formatTime(meeting.startedAt)],
    ["Last update", formatTime(meeting.updatedAt)],
    ["Conversation", <ConversationLink meeting={meeting} />],
    ["Meeting id", <span className="mono">{meeting.botId}</span>],
  ];

  return (
    <section>
      <button className="back" onClick={onBack}>
        &larr; Back to history
      </button>
      <h2>Meeting</h2>
      <div className="card">
        <dl>
          {facts.map(([label, value]) => (
            <div className="dl-row" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <h2>Bot log</h2>
      <div className="card">
        {log === null ? (
          <div className="empty">Loading...</div>
        ) : log === "" ? (
          <div className="empty">No bot log captured for this meeting.</div>
        ) : (
          <pre className="botlog">{log}</pre>
        )}
      </div>
    </section>
  );
}

function App() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [selected, setSelected] = useState<Meeting | null>(null);

  const refreshMeetings = () => {
    vfetch(`${BASE}/meetings`)
      .then((r) => (r.ok ? r.json() : []))
      .then((m: Meeting[]) => {
        setMeetings(Array.isArray(m) ? m : []);
      })
      .catch(() => {
        setMeetings((prev) => prev ?? []);
      });
  };

  useEffect(() => {
    let cancelled = false;
    vfetch(`${BASE}/settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: ConfigView | null) => {
        if (c && !cancelled) setConfig(c);
      })
      .catch(() => {});
    refreshMeetings();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      <style>{STYLES}</style>
      <h1>Meeting Bot</h1>
      <p className="sub">Configuration and meeting history.</p>
      {selected ? (
        <MeetingDetail meeting={selected} onBack={() => setSelected(null)} />
      ) : (
        <>
          <Configuration config={config} setConfig={setConfig} />
          <MeetingHistory
            provider={config?.provider ?? null}
            meetings={meetings}
            onSelect={(m) => setSelected(m)}
            onRefresh={() => {
              // Refresh now, then again shortly after: the runtime records
              // the new meeting a moment after the join request returns.
              refreshMeetings();
              setTimeout(refreshMeetings, 3000);
            }}
          />
        </>
      )}
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
