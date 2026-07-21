#!/usr/bin/env bun
/**
 * reload.ts - Reload the meeting-bot provider runtime.
 *
 * Bounces the plugin (disable then enable), which re-runs the init hook and
 * therefore tears down and restarts whichever provider runtime the config
 * selects (the Recall realtime receiver, or the Vellum Runtime subprocess).
 * Use it when the runtime is wedged or needs to pick up out-of-band changes
 * without switching providers; a provider *switch* does not need this: the
 * dashboard's provider control restarts runtimes on its own.
 *
 * Usage:
 *   bun reload.ts
 */

import { execSync } from "node:child_process";

import { getResolvedConfig } from "./meeting-bot-client.ts";

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
  let provider = "recall";
  try {
    provider = getResolvedConfig().provider ?? "recall";
  } catch {
    // No resolved config yet; the reload below still (re)initializes it.
  }

  console.error(`Reloading meeting-bot (provider: ${provider})...`);

  // Disable then enable to trigger re-initialization on the next turn. The
  // host's mtime-cache detects the .disabled sentinel changes and reloads.
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
    `meeting-bot reloaded. The ${provider} provider runtime restarts on the next conversation turn.`,
  );
}

main();
