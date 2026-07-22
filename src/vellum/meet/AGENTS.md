# src/vellum/meet: the Vellum Runtime's Meet adapter (vendored)

This tree is the in-house Google Meet bot, vendored from
`github.com/vellum-ai/meet-join` so that repo can be retired. It backs the
Vellum Runtime (`provider: "vellum"`); Recall stays the default provider.
Google Meet is the runtime's first adapter; other video-call platforms will
slot in behind the same runtime.

## Layout (preserved from the source repo so relative imports keep working)

```
contracts/           bot <-> daemon event + command schemas
daemon/              session manager, runners (docker/direct), audio ingest,
                     event routing/publishing, optional sub-modules
src/                 tool runtime slot, browser-stack bootstrap
routes/              meet-internal.ts only: the bot-event ingress route,
                     served by the in-process ingress
                     (src/vellum/ingress.ts, one level up) inside the Vellum
                     Runtime worker (per-meeting bearer tokens). Join/leave
                     control lives on the worker's own loopback server,
                     not in route files.
bot/                 the containerized bot (Chromium + extension + Pulse/Xvfb);
                     its own package, built via bot/Dockerfile (context: this dir)
meet-controller-ext/ the Chrome extension the bot loads. Its manifest `key`
                     is the extension's PUBLIC key (SPKI): it pins a stable
                     extension ID so the native-messaging-host manifest's
                     allowed_origins matches. It is not a secret.
plugin-host.ts       SkillHost interface the daemon layer is written against
config-schema.ts     services.meet config schema (read from
                     <workspace>/config/meet.json via meet-config.ts).
                     Expected to fall away as the remaining knobs migrate
                     into the plugin config or die; the join name is always
                     the assistant's name, and the bot image is the one
                     packaged with the plugin.
```

## Integration seams (owned by meeting-bot, not this tree)

- `src/vellum/worker.ts` (one level up) runs this subsystem in its own OS
  process (`vellum-worker` in `assistant ps`): backend probe, the in-process
  ingress (`src/vellum/ingress.ts`) over `routes/` here, the session
  manager with the optional sub-modules (consent, storage, TTS, lip-sync,
  barge-in, proactive chat) replaced by no-op factories via
  `MeetSessionManagerDeps`, and a loopback control server for join/leave.
  The vendored two-process ingress pair (`src/ingress-listener.ts` spawning
  `src/ingress-server.ts` over a stdio relay) is deleted: that split kept
  the TCP server out of meet-join's daemon, but here the whole runtime is
  already its own process, so the ingress binds and dispatches in-process.
- `src/vellum/runtime.ts` supervises the worker from the daemon and
  adapts relayed events into meeting-bot's session store and transcript-flush
  pipeline (`handleVellumMeetEvent`). meet-join's own conversation bridge is
  not used.
- Streaming STT for the audio ingest comes from the assistant host: the
  daemon opens sessions via the plugin-api `openTranscriptionSession`
  (feature-detected in `src/vellum/stt-api.ts`; requires a 0.10.12+ host)
  and relays audio/events over the worker's stdio channel
  (`src/vellum/stt-bridge.ts` daemon-side, `src/vellum/stt-relay.ts`
  worker-side). On older hosts the resolver degrades to null and joins fail
  with the audio ingest's descriptive error.
- The join/leave skill scripts call the worker's control endpoint at
  `127.0.0.1:listenPort` (read from resolved-config.json; loopback-only,
  internal, no token).

## Local adaptations from the source repo

Kept intentionally minimal so diffs against meet-join history stay readable:

- Type-level fixes to compile under meeting-bot's stricter tsconfig
  (`noUncheckedIndexedAccess`, narrower closure analysis):
  `daemon/chat-opportunity-detector.ts`, `daemon/consent-monitor.ts`,
  `routes/meet-internal.ts`, `src/target-meeting.ts`,
  `meet-controller-ext/src/features/chat.ts`.
- `src/ingress-listener.ts` and `src/ingress-server.ts` are deleted,
  replaced by the in-process `src/vellum/ingress.ts` (see Integration seams).
- `src/plugin-api-host.ts` and `src/plugin-runtime.ts` are deleted: the
  Vellum Runtime worker builds its own SkillHost
  (`src/vellum/worker-host.ts`), and any future daemon-side needs call
  `@vellumai/plugin-api` methods directly instead of going through a bridge.
  This also removed the last import of the deprecated `assistantEventHub`.
- Type-level fixes in the vendored `__tests__` so the whole tree typechecks
  under the root tsconfig (see Tests below).
- meet-join's hooks/tools/skills surfaces and its control route files were
  not vendored (meeting-bot has its own surfaces).

## Tests

The whole tree (bot, extension, and tests included) typechecks under the
root `tsconfig.json`; the per-package tsconfigs in bot/ and
meet-controller-ext/ remain only for their standalone build/dev flows. The
vendored suites are still excluded from the default `bun test` run (see
root `bunfig.toml`) but pass in a bare environment (suites needing Docker or
a live Meet self-skip), so CI runs them as a required job (`vellum-runtime`
in `.github/workflows/test.yml`). Run them locally with
`bun test ./src/vellum/meet`.

## Bot image

The docker backend uses the image packaged with the plugin
(`vellum-meet-bot:dev`); it is not operator-configurable. Build it from this
directory as the context:

```bash
docker build --platform linux/amd64 -f bot/Dockerfile -t vellum-meet-bot:dev .
```

With no Docker engine, the runtime falls back to running the bot as a direct
child process, which needs chromium, Xvfb, xdotool, PulseAudio, and ffmpeg on
PATH (`src/ensure-browser-stack.ts` installs them when possible) plus the
built extension (`bot/scripts/build-bot.ts`).
