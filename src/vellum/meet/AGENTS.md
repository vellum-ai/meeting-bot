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
src/                 ingress listener/server, tool runtime slot,
                     browser-stack bootstrap
routes/              meet-internal.ts only: the bot-event ingress route,
                     served by the ingress listener inside the Vellum Runtime
                     subprocess (per-meeting bearer tokens). Join/leave
                     control lives on the subprocess's own loopback server,
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

- `src/vellum/subprocess.ts` (one level up) runs this subsystem in its own OS
  process: backend probe, ingress listener over `routes/` here, the session
  manager with the optional sub-modules (consent, storage, TTS, lip-sync,
  barge-in, proactive chat) replaced by no-op factories via
  `MeetSessionManagerDeps`, and a loopback control server for join/leave.
- `src/vellum/runtime.ts` supervises the subprocess from the daemon and
  adapts relayed events into meeting-bot's session store and transcript-flush
  pipeline (`handleVellumMeetEvent`). meet-join's own conversation bridge is
  not used.
- The join/leave skill scripts call the subprocess's control endpoint (port
  in `data/vellum-control.json`; loopback-only, internal, no token).

## Local adaptations from the source repo

Kept intentionally minimal so diffs against meet-join history stay readable:

- Six type-level fixes to compile under meeting-bot's stricter tsconfig
  (`noUncheckedIndexedAccess`, narrower closure analysis):
  `daemon/chat-opportunity-detector.ts`, `daemon/consent-monitor.ts`,
  `src/ingress-listener.ts` (two casts), `routes/meet-internal.ts`,
  `src/target-meeting.ts`.
- `src/plugin-api-host.ts` and `src/plugin-runtime.ts` are deleted: the
  Vellum Runtime subprocess builds its own SkillHost
  (`src/vellum/subprocess-host.ts`), and any future daemon-side needs call
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
vendored suites are excluded from the default `bun test` run (see root
`bunfig.toml`) because several need Docker, the bot image, a browser stack,
or a live Meet; CI runs them in the non-blocking `vellum-runtime` job of
`.github/workflows/test.yml`, and the goal is to stabilize them until that
job can be made required. Run them locally with e.g.
`bun test src/vellum/meet/daemon`.

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
