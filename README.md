# meeting-bot

A Vellum Assistant plugin that sends a note-taking bot into a meeting via
[Recall.ai](https://recall.ai). Recall drives the browser and joins the call
(Google Meet, Zoom, Teams, Webex, …); the plugin stands up a realtime
WebSocket receiver that Recall streams live transcript and participant events
into.

This is the Recall-backed parallel track to the browser-extension-based
[`meet-join`](https://github.com/vellum-ai/meet-join) plugin. Where `meet-join`
runs its own containerized browser bot, `meeting-bot` offloads joining and
media capture to Recall and focuses on the realtime event pipe.

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

## Tools

- **`meeting_bot_join`** — create a bot and send it to a meeting URL.
- **`meeting_bot_leave`** — have a bot leave its call.

## Configuration app

The plugin ships a workspace-panel app (`apps/meeting-bot-dashboard/`) for
viewing meeting history and editing settings, backed by plugin HTTP routes
(`routes/`). Both are standard Vellum plugin extension surfaces (see
[Apps](https://www.vellum.ai/docs/extensibility/apps) and
[Routes](https://www.vellum.ai/docs/extensibility/routes)), so the host serves
them; the plugin does not stand up its own web server.

The app is a compiled React app (`apps/meeting-bot-dashboard/src/`, built by the
host into `dist/`). It calls the plugin's routes, served under
`/x/plugins/meeting-bot/`:

| Route                                    | Purpose                                       |
| ---------------------------------------- | --------------------------------------------- |
| `GET /x/plugins/meeting-bot/meetings`    | Meeting history as JSON (newest first).       |
| `GET /x/plugins/meeting-bot/settings`    | Current editable settings as JSON.            |
| `PATCH /x/plugins/meeting-bot/settings`  | Update settings; returns the new settings.    |

Two settings are editable:

| Setting        | Type                       | Default  |
| -------------- | -------------------------- | -------- |
| `useVoiceMode` | boolean                    | `false`  |
| `provider`     | enum (`recall` / `vellum`) | `recall` |

Settings persist to the plugin's `config.json` (the same host-owned config the
`init` hook reads); an edit merges into that file, preserving other fields.
Meeting history is read from `data/sessions.json`. Nothing consumes these
settings to change behavior yet; a later change wires them into the join /
voice-response paths.

## Configuration

The host passes config to the `init` hook as `InitContext.config`. See
[`src/config.ts`](src/config.ts) for the full schema. Required field:

| Field         | Description                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `publicWsUrl` | Stable public base URL (`wss://…`) Recall dials back into for realtime.  |

### API key

The Recall API key is **not** a config field. `config.json` carries only the
credential's *name* — `apiKeyCredential`, defaulting to `recall:api_key` — so
the secret itself lives in the secure credential store / CES rather than as
plaintext in config. Because the name defaults, an operator who stores the key
under `recall:api_key` needs no config for it at all.

At call time the plugin resolves the secret from the environment, under the
variable derived from the credential name (`recall:api_key` → `RECALL_API_KEY`).
The host provisions that value from the credential store. Set `apiKeyCredential`
only when the key is stored under a different name.

Notable optional fields: `region` (default `us-east-1`), `listenHost` /
`listenPort` (where the realtime server binds locally), `verificationToken`
(shared secret appended as `?token=…` and checked on each connection),
`events` (which realtime events to subscribe to), and `transcript.*`
(streaming provider settings).

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
