# meeting-bot

A Vellum Assistant plugin that sends the assistant itself into a meeting: it
joins the call as a participant, listens and transcribes, feeds the live
transcript into the conversation, and (as the voice path matures) speaks
back. Two providers are supported, selected by the `provider` config field:

- **`recall`** (default) — [Recall.ai](https://recall.ai) drives the browser
  and joins the call (Google Meet, Zoom, Teams, Webex, …); the plugin stands
  up a realtime WebSocket receiver that Recall streams live transcript and
  participant events into.
- **`vellum`**: the Vellum Runtime
  ([`src/vellum/`](src/vellum/meet/AGENTS.md)) joins with its own
  containerized Chromium + controller extension and streams events into the
  same session store and transcript pipeline. Google Meet is its first
  adapter; other video-call platforms will slot in behind the same runtime.

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

### The Vellum Runtime (`provider: "vellum"`)

With `provider: "vellum"`, the init hook skips the Recall receiver and spawns
the Vellum Runtime as its own worker process (`src/vellum/worker.ts`, shown
as `vellum-worker` in `assistant ps`, supervised by `src/vellum/runtime.ts`):
the same isolation the Recall receiver gets, so bot supervision and event
ingress never run on the daemon's event loop. Everything lives in that one
process: the Docker-or-direct bot backend probe, the in-process ingress the
bot POSTs events to (`src/vellum/ingress.ts`), the meet session manager that
spawns one bot per meeting, and a loopback control server on
`127.0.0.1:listenPort`. Bot transcript chunks, participant changes, and
lifecycle transitions are relayed to the daemon over stdio and adapted into
the same session store and debounced transcript flush the Recall path uses,
so everything downstream (meeting history, conversation turns) is
provider-agnostic. The join/leave skill scripts detect the provider and the
control port from the resolved config and command the runtime over that
loopback endpoint (internal-only, so no token). See
[`src/vellum/meet/AGENTS.md`](src/vellum/meet/AGENTS.md) for the vendored
tree's layout, the bot image build, and which meet-join sub-modules are
disabled.

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
| `POST /x/plugins/meeting-bot/provider`   | Switch the meeting provider (side-effectful). |

The app shows the whole config. Fields save on change (there is no Save
button): `useVoiceMode` and `region` PATCH the settings route as they are
edited, and the provider is switched through its own dedicated route
(`POST /x/plugins/meeting-bot/provider`), which tears down the old provider
runtime and starts the new one immediately. The rest is shown read-only.

| Editable field | Type                       | Default     | Via              |
| -------------- | -------------------------- | ----------- | ---------------- |
| `useVoiceMode` | boolean                    | `false`     | `PATCH /settings`|
| `region`       | enum (Recall regions)      | `us-east-1` | `PATCH /settings`|
| `provider`     | enum (`recall` / `vellum`) | `recall`    | `POST /provider` |

Settings persist to the plugin's `config.json` (the same host-owned config the
`init` hook reads); an edit merges into that file, preserving other fields. The
`GET`/`PATCH` view omits `verificationToken` so the realtime shared secret is
never sent to the browser. Meeting history is read from `data/sessions.json`.
`region` selects the Recall region; `useVoiceMode` selects the voice-response
API (see Behavior flags below) and `provider` selects the meeting provider
(applied live via its own route: the old runtime is torn down and the new one
started immediately; posting the active provider bounces its runtime).

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

Notable optional fields: `region` (default `us-east-1`), `listenPort` (the
local loopback port the active provider runtime listens on; always bound on
`127.0.0.1`), `verificationToken` (shared secret appended as `?token=…` and
checked on each connection), and `transcript.*` (streaming provider
settings). The realtime event subscription is not configurable: the plugin
always subscribes to the full set it supports (`REALTIME_EVENTS` in
`src/config.ts`).

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
of `127.0.0.1:listenPort` and set `publicWsUrl` to the tunnel's `wss://`
address. See Recall's "Local Development Setup" guide.

## Status / scope

This is an initial scaffold. Working end to end: config resolution, the
realtime server (token verification, keep-alive ping, transcript + participant
event parsing), the in-memory session store, and the join/leave tools.

Not yet wired (next steps): forwarding transcript utterances into a
conversation, bot status-change webhooks, output media (bot speaking / avatar),
and signed-header verification.
