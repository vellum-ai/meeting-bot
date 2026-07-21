/**
 * Meeting Bot dashboard app.
 *
 * A compiled (v2) React app served in the workspace panel. The host build maps
 * `react` / `react-dom` onto `preact/compat`, so this is ordinary React. It
 * talks to the plugin's routes under `/x/plugins/meeting-bot/`.
 */

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const BASE = "/x/plugins/meeting-bot";

const PROVIDERS = ["recall", "vellum"] as const;
type Provider = (typeof PROVIDERS)[number];

interface Settings {
  useVoiceMode: boolean;
  provider: Provider;
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

function Configuration() {
  const [settings, setSettings] = useState<Settings>({
    useVoiceMode: false,
    provider: "recall",
  });
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Settings | null) => {
        if (s && !cancelled) setSettings(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setStatus("Saving...");
    try {
      const res = await fetch(`${BASE}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        setSettings(await res.json());
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
        <div className="row">
          <label htmlFor="useVoiceMode">Use Voice Mode</label>
          <input
            id="useVoiceMode"
            type="checkbox"
            checked={settings.useVoiceMode}
            onChange={(e) =>
              setSettings({ ...settings, useVoiceMode: e.target.checked })
            }
          />
        </div>
        <div className="row">
          <label htmlFor="provider">Provider</label>
          <select
            id="provider"
            value={settings.provider}
            onChange={(e) =>
              setSettings({ ...settings, provider: e.target.value as Provider })
            }
          >
            <option value="recall">Recall</option>
            <option value="vellum">Vellum</option>
          </select>
        </div>
        <button onClick={save} disabled={saving}>
          Save
        </button>
        <span className="status">{status}</span>
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
