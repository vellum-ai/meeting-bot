# meet/: vendored meet-join subsystem

This tree is the in-house Google Meet bot, vendored from
`github.com/vellum-ai/meet-join` so that repo can be retired. It backs
meeting-bot's `provider: "vellum"` path; Recall stays the default provider.

## Layout (preserved from the source repo so relative imports keep working)

```
contracts/           bot <-> daemon event + command schemas
daemon/              session manager, runners (docker/direct), audio ingest,
                     event routing/publishing, optional sub-modules
src/                 ingress listener/server, plugin-api host bridge,
                     tool runtime slot, browser-stack bootstrap
routes/              files served by the ingress listener subprocess only:
                     meet-internal (bot event ingress) and control/join,
                     control/leave (called by the skill scripts). This dir is
                     deliberately separate from the plugin's top-level routes/
                     so app/settings routes are never exposed on the ingress
                     port.
bot/                 the containerized bot (Chromium + extension + Pulse/Xvfb);
                     its own package, built via bot/Dockerfile (context: meet/)
meet-controller-ext/ the Chrome extension the bot loads
plugin-host.ts       SkillHost interface the daemon layer is written against
config-schema.ts     services.meet config schema (read from
                     <workspace>/config/meet.json via meet-config.ts)
```

## Integration seams (owned by meeting-bot, not this tree)

- `src/vellum-meet.ts` (repo root `src/`) stands the runtime up: backend
  probe, ingress listener over `meet/routes/`, and the session manager with
  the optional sub-modules (consent, storage, TTS, lip-sync, barge-in,
  proactive chat) replaced by no-op factories via `MeetSessionManagerDeps`.
- Transcript/participant/lifecycle events reach meeting-bot's session store
  and transcript-flush pipeline through `handleVellumMeetEvent`, installed as
  the session manager's conversation-bridge factory. meet-join's own
  conversation bridge is not used.
- The join/leave skill scripts command the runtime through the control routes
  with the token from `data/vellum-control.json`.

## Local adaptations from the source repo

Kept intentionally minimal so diffs against meet-join history stay readable:

- Four type-level fixes to compile under meeting-bot's stricter tsconfig
  (`noUncheckedIndexedAccess`, narrower closure analysis):
  `daemon/chat-opportunity-detector.ts`, `daemon/consent-monitor.ts` (one
  indexed access each), `src/ingress-listener.ts` (two resolver casts).
- `routes/` here contains only the ingress-served files; meet-join's
  hooks/tools/skills surfaces were not vendored (meeting-bot has its own).

## Tests

The vendored suites (including Docker and live-meeting e2e) are excluded from
the default `bun test` run (see root `bunfig.toml`). Run them explicitly, e.g.
`bun test meet/daemon`, when touching this tree; several require Docker, a
browser stack, or a live Meet and are expected to fail in bare environments.

## Bot image

The docker backend expects the image named by `services.meet.containerImage`
(default `vellum-meet-bot:dev`) to exist locally. Build it from this directory
as the context:

```bash
docker build --platform linux/amd64 -f bot/Dockerfile -t vellum-meet-bot:dev .
```

With no Docker engine, the runtime falls back to running the bot as a direct
child process, which needs chromium, Xvfb, xdotool, PulseAudio, and ffmpeg on
PATH (`src/ensure-browser-stack.ts` installs them when possible) plus the
built extension (`bot/scripts/build-bot.ts`).
