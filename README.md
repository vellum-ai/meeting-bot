# meeting-bot

A Vellum Assistant plugin that sends a note-taking bot into a meeting. Two
providers are supported, selected by the `provider` config field:

- **`recall`** (default) — [Recall.ai](https://recall.ai) drives the browser
  and joins the call (Google Meet, Zoom, Teams, Webex, …); the plugin stands
  up a realtime WebSocket receiver that Recall streams live transcript and
  participant events into.
- **`vellum`** — the in-house Meet bot (vendored from the former `meet-join`
  plugin into [`meet/`](meet/AGENTS.md)) joins Google Meet with its own
  containerized Chromium + controller extension and streams events through a
  local ingress into the same session store and transcript pipeline.

## Architecture

Recall's realtime model is inverted from a typical webhook client: when a bot
is created with a `websocket` realtime endpoint, **Recall opens an outbound
connection to a URL the integration exposes** and streams in-call events over
it. So the integration must be listening at a stable, public `wss://` address
before any bot is created.

That maps cleanly onto the plugin lifecycle hooks:

| Hook       | Responsibility                                                                |
| ---------- | ----------------------------------------------------------------------------- |
| `init`     | Validate config, spawn the realtime WebSocket server subprocess               |
| `shutdown` | Stop the realtime subprocess and drop all Recall connections                  |

```
                        create bot (REST, POST /api/v1/bot/)
   ┌──────────────┐  ───────────────────────────────────────▶  ┌──────────┐
   │ meeting_bot_ │                                             │ Recall.ai│
   │ join tool    │                                             │  (joins  │
   └──────────────┘                                             │  the call)│
                                                                └────┬─────┘
        realtime WebSocket (Recall dials IN to publicWsUrl)          │
   ┌──────────────────────────────┐   ◀───────────────────────────────
   │ realtime subprocess          │      transcript.data,
   │  (own OS process, spawned    │      participant_events.*, …
   │   from init hook)            │
   │  → JSON-lines over stdio     │
   └──────────┬───────────────────┘
              │ event frames
   ┌──────────▼───────────────────┐
   │ daemon (session store)       │
   │  → tools read transcript     │
   └──────────────────────────────┘
```

The realtime server runs in its own OS process, spawned by the `init` hook and
supervised by the plugin. Events flow from Recall into the subprocess over
WebSocket, then as JSON-lines over stdio to the daemon, where they are routed
to the in-memory session store that tools read. This isolates the
connection-handling hot path from the daemon's event loop. The subprocess is
visible in the assistant's process tree (`assistant ps`).

### The vellum provider

With `provider: "vellum"`, the init hook skips the Recall receiver and stands
up the vendored meet-join runtime instead: a Docker-or-direct bot backend
probe, an ingress listener subprocess the bot POSTs events to, and the meet
session manager that spawns and supervises one bot per meeting. Bot transcript
chunks, participant changes, and lifecycle transitions are adapted into the
same session store and debounced transcript flush the Recall path uses, so
everything downstream (meeting history, conversation turns) is
provider-agnostic. The join/leave skill scripts detect the provider from the
resolved config and command the runtime over a token-authenticated local
control endpoint (`data/vellum-control.json`). See
[`meet/AGENTS.md`](meet/AGENTS.md) for the vendored tree's layout, the bot
image build, and which meet-join sub-modules are disabled.

## Tools

- **`meeting_bot_join`** — create a bot and send it to a meeting URL.
- **`meeting_bot_leave`** — have a bot leave its call.

## Configuration app

The plugin ships a workspace-panel app (`apps/meeting-bot-dashboard/`) for
viewing meeting history and editing settings, backed by plugin HTTP routes
(`routes/`).

The app is a compiled React app (`apps/meeting-bot-dashboard/src/`, built by the
host into `dist/`). It calls the plugin's routes, served under
`/x/plugins/meeting-bot/`:

| Route                                    | Purpose                                       |
| ---------------------------------------- | --------------------------------------------- |
| `GET /x/plugins/meeting-bot/meetings`    | Meeting history as JSON (newest first).       |
| `GET /x/plugins/meeting-bot/settings`    | The resolved config for display, as JSON.     |
| `PATCH /x/plugins/meeting-bot/settings`  | Update the editable fields; returns the view. |

The app shows the whole config. Three fields are editable; the rest are shown
read-only.

| Editable field | Type                       | Default     |
| -------------- | -------------------------- | ----------- |
| `useVoiceMode` | boolean                    | `false`     |
| `provider`     | enum (`recall` / `vellum`) | `recall`    |
| `region`       | enum (Recall regions)      | `us-east-1` |

Settings persist to the plugin's `config.json` (the same host-owned config the
`init` hook reads); an edit merges into that file, preserving other fields. The
`GET`/`PATCH` view omits `verificationToken` so the realtime shared secret is
never sent to the browser. Meeting history is read from `data/sessions.json`.
`region` selects the Recall region; `useVoiceMode` selects the voice-response
API (see Behavior flags below) and `provider` selects the meeting provider
(picked up on the next plugin reload).

## Configuration

The host passes config to the `init` hook as `InitContext.config`. See
[`src/config.ts`](src/config.ts) for the full schema. Required field:

| Field         | Description                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `publicWsUrl` | Stable public base URL (`wss://…`) Recall dials back into for realtime.  |

### API key

The Recall API key is **not** a config field, and the credential name is not
configurable. The plugin always resolves it from one fixed credential (service
`meeting-bot`, field `api_key`) in the secure credential store, so the secret
never lives as plaintext in `config.json`. Store it with:

```bash
assistant credentials set --service meeting-bot --field api_key "recall_..."
```

At call time the plugin resolves it in-process via the host's `resolveCredential`.

Notable optional fields: `region` (default `us-east-1`), `listenHost` /
`listenPort` (where the realtime server binds locally), `verificationToken`
(shared secret appended as `?token=…` and checked on each connection),
`events` (which realtime events to subscribe to), and `transcript.*`
(streaming provider settings).

### Behavior flags

- `useVoiceMode` (default `false`): selects how the bot's voice responses are
  produced. When true, use the host's new `createLiveVoiceConnection` live-voice
  API; when false, use the existing text-to-speech + Recall `output_audio` path.
  This is a temporary flag until `createLiveVoiceConnection` is stable enough to
  rely on full time, after which the config is removed. The
  `createLiveVoiceConnection` path is not wired yet (pending that API landing in
  `@vellumai/plugin-api`), so every response currently uses the TTS path.
- `outputAudio` (default `false`): reserved for a future change. When true the
  bot may output audio (speak) in the meeting; when false it only listens and
  transcribes. Defined but not consumed yet.

### Local development

Recall needs a stable public URL. In dev, put a static `ngrok` tunnel in front
of `listenHost:listenPort` and set `publicWsUrl` to the tunnel's `wss://`
address. See Recall's "Local Development Setup" guide.

## Status / scope

This is an initial scaffold. Working end to end: config resolution, the
realtime server (token verification, keep-alive ping, transcript + participant
event parsing), the in-memory session store, and the join/leave tools.

Not yet wired (next steps): forwarding transcript utterances into a
conversation, bot status-change webhooks, output media (bot speaking / avatar),
and signed-header verification.
