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

| Hook       | Responsibility                                                        |
| ---------- | --------------------------------------------------------------------- |
| `init`     | Validate config, start the realtime WebSocket server (one per plugin) |
| `shutdown` | Stop the realtime server and drop all Recall connections              |

```
                        create bot (REST, POST /api/v1/bot/)
   ┌──────────────┐  ───────────────────────────────────────▶  ┌──────────┐
   │ meeting_bot_ │                                             │ Recall.ai│
   │ join tool    │                                             │  (joins  │
   └──────────────┘                                             │  the call)│
                                                                └────┬─────┘
        realtime WebSocket (Recall dials IN to publicWsUrl)          │
   ┌──────────────────────────────┐   ◀───────────────────────────────
   │ realtime server (init hook)  │      transcript.data,
   │  → session store             │      participant_events.*, …
   └──────────────────────────────┘
```

The realtime server is a process-wide singleton and outlives individual
meetings — one listener demultiplexes every concurrent bot by bot id.

## Tools

- **`meeting_bot_join`** — create a bot and send it to a meeting URL.
- **`meeting_bot_leave`** — have a bot leave its call.

## Configuration

The host passes config to the `init` hook as `InitContext.config`. See
[`src/config.ts`](src/config.ts) for the full schema. Required fields:

| Field         | Description                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `apiKey`      | Recall.ai workspace API key (region-scoped).                             |
| `publicWsUrl` | Stable public base URL (`wss://…`) Recall dials back into for realtime.  |

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
