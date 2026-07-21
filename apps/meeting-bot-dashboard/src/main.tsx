/**
 * Meeting Bot dashboard app.
 *
 * A compiled (v2) React app served in the workspace panel. The host build maps
 * `react` / `react-dom` onto `preact/compat`, so this is ordinary React. It
 * talks to the plugin's routes under `/x/plugins/meeting-bot/`.
 *
 * The Configuration view shows the whole plugin config. A few fields are
 * editable (voice mode, provider, region); the rest are shown read-only.
 */

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const BASE = "/x/plugins/meeting-bot";

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
  listenHost?: string;
  listenPort?: number;
  events?: string[];
  transcript?: { provider?: string; languageCode?: string; mode?: string };
}

interface Meeting {
  botId: string;
  meetingUrl: string;
  conversationId: string | null;
  startedAt: number;
}

function formatTime(ms: number): string {
  if (!ms) return "-";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/** Rows of read-only config shown below the editable fields. */
function readOnlyRows(config: ConfigView): Array<[string, string]> {
  return [
    ["Public WS URL", config.publicWsUrl || "(not set)"],
    ["Listen host", config.listenHost || "-"],
    ["Listen port", config.listenPort != null ? String(config.listenPort) : "-"],
    ["Realtime events", (config.events ?? []).join(", ") || "-"],
    ["Transcript mode", config.transcript?.mode || "-"],
  ];
}

/** Per-field save state: which field is in flight, and the last outcome. */
type FieldState = "idle" | "saving" | "saved" | "error";

function Configuration() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [fieldState, setFieldState] = useState<Record<string, FieldState>>({});
  const [providerNote, setProviderNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    vfetch(`${BASE}/settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: ConfigView | null) => {
        if (c && !cancelled) setConfig(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

function MeetingHistory() {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    vfetch(`${BASE}/meetings`)
      .then((r) => (r.ok ? r.json() : []))
      .then((m: Meeting[]) => {
        if (!cancelled) setMeetings(Array.isArray(m) ? m : []);
      })
      .catch(() => {
        if (!cancelled) setMeetings([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = meetings ?? [];

  return (
    <section>
      <h2>Meeting history</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Meeting</th>
              <th>Bot</th>
              <th>Conversation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.botId}>
                <td>{formatTime(m.startedAt)}</td>
                <td className="url">{m.meetingUrl || "-"}</td>
                <td className="mono">{m.botId || "-"}</td>
                <td className="mono">{m.conversationId || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {meetings !== null && rows.length === 0 ? (
          <div className="empty">No meetings recorded yet.</div>
        ) : null}
      </div>
    </section>
  );
}

function App() {
  return (
    <div className="app">
      <h1>Meeting Bot</h1>
      <p className="sub">Configuration and meeting history.</p>
      <Configuration />
      <MeetingHistory />
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
