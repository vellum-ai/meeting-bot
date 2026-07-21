/**
 * Tests for the editable settings, which live in the plugin's config.json.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAppSettings, updateAppSettings } from "../app-settings.ts";

function configPath(contents?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-bot-config-"));
  const path = join(dir, "config.json");
  if (contents !== undefined) {
    writeFileSync(path, JSON.stringify(contents), "utf-8");
  }
  return path;
}

describe("readAppSettings", () => {
  test("returns defaults when config.json is missing", () => {
    expect(readAppSettings(configPath())).toEqual({
      useVoiceMode: false,
      provider: "recall",
    });
  });

  test("returns defaults when config.json is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-bot-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "not json", "utf-8");
    expect(readAppSettings(path)).toEqual({
      useVoiceMode: false,
      provider: "recall",
    });
  });

  test("reads the two fields out of config.json", () => {
    const path = configPath({
      publicWsUrl: "wss://x",
      useVoiceMode: true,
      provider: "vellum",
    });
    expect(readAppSettings(path)).toEqual({
      useVoiceMode: true,
      provider: "vellum",
    });
  });

  test("defaults an invalid provider and missing voice flag", () => {
    const path = configPath({ provider: "zoom" });
    expect(readAppSettings(path)).toEqual({
      useVoiceMode: false,
      provider: "recall",
    });
  });
});

describe("updateAppSettings", () => {
  test("persists an update and preserves unrelated config fields", () => {
    const path = configPath({ publicWsUrl: "wss://x", region: "us-west-2" });

    const result = updateAppSettings(path, {
      useVoiceMode: true,
      provider: "vellum",
    });
    expect(result).toEqual({ useVoiceMode: true, provider: "vellum" });

    // Unrelated fields survive the merge.
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      publicWsUrl: "wss://x",
      region: "us-west-2",
      useVoiceMode: true,
      provider: "vellum",
    });
  });

  test("a single-field update preserves the other setting", () => {
    const path = configPath({ useVoiceMode: true, provider: "recall" });
    const result = updateAppSettings(path, { provider: "vellum" });
    expect(result).toEqual({ useVoiceMode: true, provider: "vellum" });
  });

  test("creates config.json when it does not exist", () => {
    const path = configPath();
    const result = updateAppSettings(path, { useVoiceMode: true });
    expect(result).toEqual({ useVoiceMode: true, provider: "recall" });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      useVoiceMode: true,
    });
  });
});
