#!/usr/bin/env bun
/**
 * reload.ts - Restart the meeting-bot provider runtime, now.
 *
 * Writes a reload request into the plugin's data directory; the plugin's
 * daemon-side reload watcher (started by the init hook, see
 * src/reload-watcher.ts) picks it up, tears down and restarts whichever
 * provider runtime the config selects (the Recall realtime receiver, or
 * the Vellum Runtime worker), and writes the outcome back. This script
 * waits for that outcome, so the restart completes on THIS conversation
 * turn and the printed message reflects what actually happened.
 *
 * Fallback: when no result arrives (the plugin is not loaded, so no
 * watcher is running), the script falls back to bouncing the plugin via
 * `assistant plugins disable` / `enable`, which the host reconciles at the
 * next conversation-turn boundary; the message says so honestly.
 *
 * Usage:
 *   bun reload.ts
 */

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findPluginDataDir, getResolvedConfig } from "./meeting-bot-client.ts";

/** How long to wait for the daemon-side watcher to report the outcome. */
const RESULT_WAIT_MS = 30_000;
/** Interval between result-file polls. */
const RESULT_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, output };
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    return { ok: false, output };
  }
}

/** Bounce the plugin via disable/enable; takes effect on the NEXT turn. */
function fallbackPluginBounce(provider: string): void {
  const disable = run("assistant plugins disable meeting-bot");
  if (!disable.ok) {
    console.error(`Failed to disable plugin: ${disable.output}`);
    process.exit(1);
  }
  try {
    execSync("sleep 0.5");
  } catch {
    // sleep may be unavailable; continue anyway
  }
  const enable = run("assistant plugins enable meeting-bot");
  if (!enable.ok) {
    console.error(`Failed to enable plugin: ${enable.output}`);
    process.exit(1);
  }
  console.log(
    `meeting-bot was not responding to live reload (plugin not loaded?); bounced it via disable/enable instead. ` +
      `The ${provider} provider runtime initializes on the next conversation turn.`,
  );
}

async function main(): Promise<void> {
  let provider = "recall";
  try {
    provider = getResolvedConfig().provider ?? "recall";
  } catch {
    // No resolved config yet; the reload below still (re)initializes it.
  }

  console.error(`Reloading meeting-bot (provider: ${provider})...`);

  const dataDir = findPluginDataDir();
  const requestId = randomUUID();
  writeFileSync(
    join(dataDir, "reload-request.json"),
    JSON.stringify({ id: requestId, at: Date.now() }, null, 2),
    "utf-8",
  );

  const resultPath = join(dataDir, "reload-result.json");
  const deadline = Date.now() + RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(RESULT_POLL_MS);
    if (!existsSync(resultPath)) continue;
    try {
      const result = JSON.parse(readFileSync(resultPath, "utf-8")) as {
        id?: unknown;
        ok?: unknown;
        note?: unknown;
      };
      if (result.id !== requestId) continue; // stale result from an earlier reload
      const note = typeof result.note === "string" ? result.note : "";
      if (result.ok === false) {
        console.error(`meeting-bot reload failed: ${note}`);
        process.exit(1);
      }
      console.log(`meeting-bot reloaded: ${note}`);
      return;
    } catch {
      // torn write; retry next poll
    }
  }

  fallbackPluginBounce(provider);
}

await main();
