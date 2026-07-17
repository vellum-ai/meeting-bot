#!/usr/bin/env bun
/**
 * reload.ts - Reload the meeting-bot plugin after credential setup.
 *
 * After the user provides their Recall API key and it is stored in the
 * credential store, the plugin needs to re-initialize to pick up the new
 * key and start the realtime server. This script triggers a plugin reload
 * by disabling and re-enabling the plugin via the CLI.
 *
 * Usage:
 *   bun reload.ts
 */

import { execSync } from "node:child_process";

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

function main(): void {
  // Verify the credential is now set before reloading
  const check = run(
    "assistant credentials reveal --service meeting-bot --field api_key",
  );
  if (!check.ok || !check.output) {
    console.error(
      "Recall API key is not set in the credential store. " +
        "Store one with: assistant credentials set --service meeting-bot --field api_key <your_key>",
    );
    process.exit(1);
  }

  console.error("Recall API key found. Reloading meeting-bot plugin...");

  // Disable then enable to trigger re-initialization on the next turn.
  // The mtime-cache detects the .disabled sentinel file changes and
  // re-activates the plugin.
  const disable = run("assistant plugins disable meeting-bot");
  if (!disable.ok) {
    console.error(`Failed to disable plugin: ${disable.output}`);
    process.exit(1);
  }

  // Brief pause to ensure the sentinel file is detected
  const sleep = (ms: number) => execSync(`sleep ${ms / 1000}`);

  try {
    sleep(500);
  } catch {
    // sleep might not be available on all platforms; continue anyway
  }

  const enable = run("assistant plugins enable meeting-bot");
  if (!enable.ok) {
    console.error(`Failed to enable plugin: ${enable.output}`);
    process.exit(1);
  }

  console.log("meeting-bot plugin reloaded. The realtime server will start on the next conversation turn.");
}

main();
