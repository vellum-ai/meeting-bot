# Velay: plugin-API surfaces the assistant side needs to expose

Status: **draft / for discussion.** Written from the plugin's side of the
boundary while reshaping the `vellum` provider into a Velay client. Nothing
here is implemented in `@vellumai/plugin-api` yet; the intent is to
back-propagate whatever survives review into `vellum-assistant` and
`vellum-assistant-platform`.

## Context

`vellum` used to mean "the plugin drives its own Chromium into the call".
That is being retired — the blockers are platform policy, not engineering:

- **Google Meet** hard-denies anonymous automated clients at knock
  submission. The sanctioned paths are the Meet Media API (Developer
  Preview, requires *every participant* enrolled) and Bots on Demand
  (allowlist-only).
- **Zoom** requires, as of 2 March 2026, a ZAK or OBF token for any Meeting
  SDK app joining a meeting outside its own account. An OBF token is tied
  to a real participant who is already present, and the bot disconnects
  when they leave.

Velay absorbs those problems behind a service boundary. The plugin becomes
a client: it opens a WebSocket to Velay, asks for a bot in a meeting, and
consumes transcript/participant/lifecycle events.

**Direction matters.** `recall` is inbound — Recall dials a public `wss://`
URL the plugin exposes, which is why that path needs a tunnel, a public
address, and a verification token. Velay is outbound — the plugin dials
Velay. That removes the tunnel, the public surface, and the inbound-auth
story entirely. It is the single biggest simplification in this reshape.

## What the plugin needs from the host

### 1. A credential for Velay

The plugin needs an opaque token for the `hello` frame. The existing
`resolveCredential` covers reading it (`meeting-bot/velay_token`, following
the `api_key` precedent), so **no new read API is required**.

What is missing is a **write** path. Today a plugin can only ask for a
secret from inside a tool context (`requestSecret`), and the config app
cannot reach that. Storing a credential from a plugin HTTP route means
shelling out to `assistant credentials set`, which must be spawned
asynchronously — a synchronous spawn from a daemon route deadlocks on the
CLI's IPC back to the daemon.

**Ask:** a first-class `storeCredential(ref, value)` in `plugin-api`,
usable from a route handler, with the same plugin scoping `resolveCredential`
already enforces. This is not Velay-specific — any plugin whose config app
collects a secret hits it.

### 2. Outbound WebSocket egress

The plugin dials an external `wss://` endpoint from the daemon process.
Worth confirming explicitly:

- Is outbound WebSocket allowed from the daemon in all deployment targets
  (desktop, hosted, containerized)?
- Does egress go through a proxy that needs configuring, as HTTPS does?

**Ask:** either a documented guarantee that outbound `wss://` works, or a
host-provided socket factory the plugin can use so proxy/TLS policy stays
the host's concern. The client's `VelaySocketFactory` seam exists precisely
so a host-provided factory can be dropped in without touching the protocol
code.

### 3. Nothing new for transcripts

Deliberately called out: Velay events map onto the `MeetBotEvent` shapes the
plugin already emits, so the session store, debounced transcript flush,
conversation bridge, and meeting history need **no changes**. This is the
main reason the protocol in `contracts.ts` is shaped the way it is — it is
written to fit the existing downstream, not to be elegant in isolation.

If Velay does its own transcription, the plugin's STT relay
(`src/vellum/stt-bridge.ts` / `stt-relay.ts`) becomes dead weight on this
path. It stays for `recall` and should not be removed until the Velay path
is real.

### 4. Speaking into the call — open question

The provisional protocol sends **text** on `speak` and lets Velay voice it.
The alternative is the plugin running its configured TTS and streaming
audio. Text-only keeps the socket small and avoids PCM framing, but it
means the assistant's configured voice does not carry into the meeting.

**Ask:** decide which side owns TTS for Velay-backed meetings. If it is the
plugin, this protocol needs an audio channel and the host needs to expose a
streaming TTS surface analogous to `openTranscriptionSession`.

## What the plugin exposes to the assistant (unchanged)

No new tools. `meeting_bot_join` / `meeting_bot_leave` keep their contracts;
only the provider branch behind them changes. The dashboard grows a Velay
endpoint field, and the provider enum eventually gains a value — the current
`vellum` entry can be reused rather than adding a third, since it is the
same provider with a new backend.

## Open questions for Velay

1. **Auth model** — static workspace key, short-lived token, or OAuth?
   Drives whether the plugin needs refresh logic.
2. **Session resumption** — after a reconnect, does Velay still consider
   prior meetings live, or must the plugin re-issue joins? The client
   deliberately does not own meeting state, so this is the caller's
   contract to write.
3. **Backpressure** — is there a rate limit on `speak` / `send_chat`, and
   does Velay signal it, or must the plugin self-limit?
4. **Platform coverage** — which platforms does Velay join, and does it
   report capability so the plugin can refuse early rather than after a
   failed join? `src/meeting-platform.ts` already detects Meet/Zoom/Teams
   from a URL and is the natural place to consult that.
5. **Media fidelity** — are per-participant audio streams available, or
   only a mixed transcript? Affects diarization quality downstream.
