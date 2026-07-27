# meet-bot — Agent Instructions

## Architecture

The meet-bot runs **google-chrome-stable as a plain user-process subprocess** (no CDP, no automation framework). Browser-side DOM work happens inside a sibling Chrome extension package at `../meet-controller-ext/`, loaded via `--load-extension=/app/ext` by `src/browser/chrome-launcher.ts`.

Bot ↔ extension communication flows through Chrome Native Messaging:

- The bot's NMH Unix-socket server (`src/native-messaging/socket-server.ts`) listens on `/run/nmh.sock`.
- The NMH shim (`src/native-messaging/nmh-shim.ts`) is the process Chrome spawns in response to `chrome.runtime.connectNative(...)`. It bridges Chrome's stdin/stdout NMH protocol to the Unix socket.
- Message shapes are declared in `../contracts/native-messaging.ts` (`BotToExtensionMessage` and `ExtensionToBotMessage`, with zod validation on both ends).
- The shim's manifest is rendered at image-build time by `scripts/render-nmh-manifest.ts`, which reads the extension's `manifest.json`, derives the extension ID from its public key, and writes the manifest to `/etc/opt/chrome/native-messaging-hosts/com.vellum.meet.json` with `allowed_origins` set to the derived extension origin.

## What belongs where

- **Bot side** (`src/`):
  - Process boot sequence (`main.ts`): Pulse → Xvfb → NMH socket server → daemon client → Chrome subprocess → `waitForReady` → dispatch `join` → audio capture → HTTP control surface.
  - HTTP control surface for the daemon (`src/control/http-server.ts` — `/leave`, `/send_chat`, `/play_audio`).
  - Daemon client (`src/control/daemon-client.ts` — outbound event ingress).
  - Audio capture (`src/media/audio-capture.ts` — parec piped into a TCP socket on `host.docker.internal:<DAEMON_AUDIO_PORT>` where the daemon's audio-ingest server listens).
  - Audio playback (`src/media/audio-playback.ts` — pacat fed from the daemon's `/play_audio` stream).
  - Native messaging transport (`src/native-messaging/`).
  - Chrome process lifecycle (`src/browser/chrome-launcher.ts`) and Xvfb (`src/browser/xvfb.ts`).
- **Extension side** (`../meet-controller-ext/src/features/`):
  - Join flow (`join.ts`).
  - Participant scraping (`participants.ts`).
  - Speaker indicator (`speaker.ts`).
  - Chat send + inbound chat reader (`chat.ts`).
  - DOM selectors (`../dom/selectors.ts`) and wait helpers (`../dom/wait.ts`).

Do not add Playwright, Puppeteer, or any CDP-based library to this package. The entire reason for the extension architecture is that Google Meet's BotGuard rejects CDP-attached clients before the prejoin renders — see the Phase 1.11 plan at `.private/plans/archived/meet-phase-1-11-chrome-extension.md` for the empirical repro.

## BotGuard: anonymous joins are currently refused (2026-07)

QA established, with page surveys + `knock.png`, that Meet **hard-denies** our anonymous client at knock submission:

- The prejoin surface renders, the name is accepted, the trusted click registers — then Meet replaces the page with **"You can't join this video call"** and a 60s "Returning to home screen" countdown, after which the tab is redirected to `workspace.google.com/products/meet/`. The ~61s bounces in earlier logs were that countdown, not a timeout.
- No `accounts.google.com` redirect, and **no admit prompt ever reaches the host** — the request is killed before it gets there. The page's "invited or admitted by the host" copy is generic reassurance, not a description of what happened.
- This is the same denial string BotGuard used for CDP-attached clients above; the detector now evaluates at the join request rather than at page load.

The join flow fails fast on this string (`detectJoinDenial` in `../meet-controller-ext/src/features/join.ts`) instead of waiting out the countdown.

**What is known about the sanctioned paths:**

- Recall.ai's own guide to building an in-house Meet bot states plainly that a **real Google account is required** and that service accounts do not work. Recall's *customers* don't supply credentials because Recall provisions and rotates its own bot accounts — not because the join is anonymous. Anonymous joining is not a capability we are missing; it is one Google does not offer.
- The **Meet Media API** is Google's first-class real-time media path, but it is Developer Preview and requires *every participant* to be enrolled in the preview program — unusable for joining arbitrary customer meetings.
- **Bots on Demand** exists for automated participants but is allowlist-only and aimed at performance testing.

Zoom is no better: since 2 March 2026 a Meeting SDK app joining a meeting outside its own account needs a ZAK or OBF token, and an OBF token is tied to a real participant who is already present — the bot cannot join before they arrive and disconnects when they leave.

## Direction: this tree is being superseded (2026-07)

Two options were considered and **both are closed**:

- *Trust-signal hygiene* (persistent profile, quieter launch flags) — an arms race against an anti-abuse system Google maintains, with no durable win.
- *A signed-in bot account* — workable in principle, but it means provisioning and rotating Google accounts, storing their passwords, and automating a login form that fights back with 2FA and device challenges.

Neither is an engineering problem this repo can settle, so the `vellum` provider is being reshaped into a **client of Velay** rather than a browser driver: see [`src/velay/`](../../../velay/PLUGIN-SURFACE.md). This tree stays in place and keeps working for now; it should not be extended. New work on the `vellum` path belongs in `src/velay/`.

The diagnostics built during this investigation — the page surveys, `knock.png`, `failure.png`, and the off-meet navigation report — are worth keeping regardless: they are what turned "the bot times out" into "Meet refuses this client at knock submission, here is the pixel evidence".

## Testing

```bash
cd skills/meet-join/bot
bun install
bunx tsc --noEmit
bun test __tests__/
```

All tests in `__tests__/` must pass. The boot smoke test uses `SKIP_PULSE=1` so it works on macOS developer machines; the `main.test.ts` harness stubs every subsystem (Pulse, Xvfb, Chrome, NMH socket, daemon client, HTTP server) through `BotDeps` injection so the boot and shutdown paths can be verified without touching real processes.
