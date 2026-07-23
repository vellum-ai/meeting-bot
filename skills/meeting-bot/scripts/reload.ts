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
 * When no result arrives (the plugin is not loaded, so no watcher is
 * running), the script reports that and exits nonzero. It deliberately
 * does NOT fall back to `assistant plugins disable` / `enable`: a plugin
 * must never self-disable or self-enable (side effects beyond the
 * runtime, and a disabled plugin's scripts may not be able to re-enable
 * it). The reload's whole job is reusing the runtime start/stop logic
 * that backs the init and shutdown hooks.
 *
 * Usage:
 *   bun reload.ts
 */

import { randomUUID } from "node:crypto";
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

async function main(): Promise<void> {
  let provider = "recall";
  try {
    provider = getResolvedConfig().provider ?? "recall";
  } catch {
    // No resolved config yet (plugin never initialized). The request below
    // will go unanswered and the timeout message covers it.
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

  console.error(
    `meeting-bot did not respond to the reload request within ${RESULT_WAIT_MS / 1000}s. ` +
      `The plugin does not appear to be loaded (its reload watcher runs from the init hook), ` +
      `so there is no ${provider} provider runtime to restart. ` +
      `Ensure the meeting-bot plugin is installed and enabled, then run this script again.`,
  );
  process.exit(1);
}

await main();
