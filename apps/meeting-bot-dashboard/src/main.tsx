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
  apiKeyCredential?: string;
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
    ["API key credential", config.apiKeyCredential || "-"],
    ["Listen host", config.listenHost || "-"],
    ["Listen port", config.listenPort != null ? String(config.listenPort) : "-"],
    ["Realtime events", (config.events ?? []).join(", ") || "-"],
    ["Transcript provider", config.transcript?.provider || "-"],
    ["Transcript language", config.transcript?.languageCode || "-"],
    ["Transcript mode", config.transcript?.mode || "-"],
  ];
}

function Configuration() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: ConfigView | null) => {
        if (c && !cancelled) setConfig(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!config) return;
    setSaving(true);
    setStatus("Saving...");
    try {
      const res = await fetch(`${BASE}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          useVoiceMode: config.useVoiceMode,
          provider: config.provider,
          region: config.region,
        }),
      });
      if (res.ok) {
        setConfig(await res.json());
        setStatus("Saved");
      } else {
        setStatus("Save failed");
      }
    } catch {
      setStatus("Save failed");
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(""), 2500);
    }
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
              <input
                id="useVoiceMode"
                type="checkbox"
                checked={config.useVoiceMode}
                onChange={(e) =>
                  setConfig({ ...config, useVoiceMode: e.target.checked })
                }
              />
            </div>
            <div className="row">
              <label htmlFor="provider">Provider</label>
              <select
                id="provider"
                value={config.provider}
                onChange={(e) =>
                  setConfig({ ...config, provider: e.target.value as Provider })
                }
              >
                <option value="recall">Recall</option>
                <option value="vellum">Vellum</option>
              </select>
            </div>
            <div className="row">
              <label htmlFor="region">Region</label>
              <select
                id="region"
                value={config.region}
                onChange={(e) =>
                  setConfig({ ...config, region: e.target.value as Region })
                }
              >
                {REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <button onClick={save} disabled={saving}>
              Save
            </button>
            <span className="status">{status}</span>

            <div className="readonly">
              <div className="readonly-title">Other configuration (read-only)</div>
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
    fetch(`${BASE}/meetings`)
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
