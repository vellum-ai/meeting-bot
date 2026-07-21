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
src/                 ingress listener/server, plugin-api host bridge,
                     tool runtime slot, browser-stack bootstrap
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
                     <workspace>/config/meet.json via meet-config.ts; the
                     commonly tuned fields are consolidated into the plugin's
                     own config.json `meet` section, which wins)
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
- `src/plugin-api-host.ts`: the memory.addMessage, identity.getAssistantName,
  providers.llm.getConfigured, and providers.secureKeys.getProviderKey facets
  are now backed by real `@vellumai/plugin-api` exports (addMessage,
  getAssistantName, getConfiguredProvider, resolveCredential). STT, TTS, and
  speaker tracking still have no plugin-api equivalent.
- `meet-config.ts`: gained `setMeetConfigOverrides` so the fields
  consolidated into the plugin's config.json (`meet.joinName`,
  `meet.consentMessage`, `meet.containerImage`) win over
  `<workspace>/config/meet.json`.
- meet-join's hooks/tools/skills surfaces and its control route files were
  not vendored (meeting-bot has its own surfaces).

## Tests

The vendored suites (including Docker and live-meeting e2e) are excluded from
the default `bun test` run (see root `bunfig.toml`) and from the root tsc
program (see root `tsconfig.json` excludes; bot/ and meet-controller-ext/
keep their own tsconfigs for their different lib needs). Run them explicitly,
e.g. `bun test src/vellum/meet/daemon`, when touching this tree; several
require Docker, a browser stack, or a live Meet and are expected to fail in
bare environments.

## Bot image

The docker backend expects the image named by `meet.containerImage` in the
plugin config (default `vellum-meet-bot:dev`) to exist locally. Build it from
this directory as the context:

```bash
docker build --platform linux/amd64 -f bot/Dockerfile -t vellum-meet-bot:dev .
```

With no Docker engine, the runtime falls back to running the bot as a direct
child process, which needs chromium, Xvfb, xdotool, PulseAudio, and ffmpeg on
PATH (`src/ensure-browser-stack.ts` installs them when possible) plus the
built extension (`bot/scripts/build-bot.ts`).
