# AGENTS.md — meeting-bot plugin

Notes for agents (and humans) working in this repo.

## What this is

A standalone Vellum Assistant plugin (external plugin, installed via
`assistant plugins install`). It sends meeting bots via Recall.ai and receives
their realtime event streams. It is the Recall-backed counterpart to the
`meet-join` plugin.

## Layout (discovery is by convention)

```
hooks/init.ts        default-exports the init hook     (start realtime server)
hooks/shutdown.ts    default-exports the shutdown hook  (stop realtime server)
tools/*.ts           default-export a ToolDefinition each (auto-discovered)
src/                 internals (config, recall client, realtime server, store)
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
  `src/plugin-state.ts` for the tools. Tools call `requireConfig()`.

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
