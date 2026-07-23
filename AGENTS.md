# AGENTS.md — meeting-bot plugin

Notes for agents (and humans) working in this repo.

## What this is

A standalone Vellum Assistant plugin (external plugin, installed via
`assistant plugins install`). It sends meeting bots via Recall.ai and receives
their realtime event streams. It is the Recall-backed counterpart to the
`meet-join` plugin.

## Layout (discovery is by convention)

```
hooks/init.ts        default-exports the init hook     (provider switch: Recall realtime server, or the Vellum Runtime)
hooks/shutdown.ts    default-exports the shutdown hook  (stop whichever runtime is up)
routes/*.ts          HTTP routes under /x/plugins/meeting-bot/ (named GET/POST/PATCH exports)
apps/meeting-bot-dashboard/  workspace-panel app (compiled React under src/) for history + settings
skills/meeting-bot/  join/leave skill with scripts       (run as standalone bun processes; branch on config.provider)
skills/meeting-bot-setup/  setup skill (guides user through credential setup)
src/                 internals (config, recall client, realtime server, store, app routes/settings)
src/vellum/          the Vellum Runtime: worker process + supervisor, with the vendored
                     meet adapter under src/vellum/meet (see src/vellum/meet/AGENTS.md).
                     Meet is the first adapter; other video-call platforms will slot
                     in behind the same runtime.
```

There is no `register.ts` and no host stub: the plugin talks to the host only
through `@vellumai/plugin-api` (hook context types, `ToolDefinition`,
`RiskLevel`). Keep it that way — do not reach into `assistant/src/…`.

## Conventions

- TypeScript + Bun only. No Python. Intra-repo imports use explicit `.ts`
  extensions (Bun resolves them; `tsconfig` sets `allowImportingTsExtensions`).
- Pin `@vellumai/plugin-api` as a `peerDependency` at `^0.10.3`.
- No em-dash characters in source or docs; no PR numbers in code comments.
- Config is validated once in `src/config.ts` (`resolveConfig`) and stashed in
  `src/plugin-state.ts` for in-process use (realtime server). The init hook
  also writes `resolved-config.json` to the plugin's data directory so skill
  scripts (join, leave) can read it. Sessions are written to `sessions.json`
  by the join script and synced into the in-memory store by the realtime
  server. The Recall API key is resolved from the credential store via
  `assistant credentials reveal` (default credential: `meeting-bot:api_key`).

## Recall.ai model (why the hooks matter)

Recall connects **outbound** to the `wss://` URL the plugin exposes. The
realtime server therefore has to be up before any bot is created, which is why
it is started in `init` and stopped in `shutdown`, not lazily per meeting. One
server fields every concurrent bot; events are demultiplexed by bot id.

Key REST calls: `POST /api/v1/bot/` (create, may 507 with no capacity — retry),
`POST /api/v1/bot/{id}/leave_call/`. Realtime events arrive as JSON frames with
a top-level `event` discriminator; parsing is lenient by design (see
`src/realtime-events.ts`).

## Typecheck

```
bunx tsc --noEmit
```
