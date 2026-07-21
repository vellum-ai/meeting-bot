/**
 * Tests for the config view and editable-field updates, which live in the
 * plugin's config.json.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyConfigUpdate,
  applyProviderChange,
  readConfigView,
} from "../app-settings.ts";

function configPath(contents?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-bot-config-"));
  const path = join(dir, "config.json");
  if (contents !== undefined) {
    writeFileSync(path, JSON.stringify(contents), "utf-8");
  }
  return path;
}

describe("readConfigView", () => {
  test("returns resolved defaults for a fresh install", () => {
    const view = readConfigView(configPath());
    expect(view.useVoiceMode).toBe(false);
    expect(view.provider).toBe("recall");
    expect(view.region).toBe("us-east-1");
    expect(view.listenPort).toBe(8790);
    // The realtime shared secret is never surfaced.
    expect(view).not.toHaveProperty("verificationToken");
  });

  test("reads the editable fields out of config.json", () => {
    const view = readConfigView(
      configPath({
        region: "us-west-2",
        useVoiceMode: true,
        provider: "vellum",
        publicWsUrl: "wss://x",
      }),
    );
    expect(view.region).toBe("us-west-2");
    expect(view.useVoiceMode).toBe(true);
    expect(view.provider).toBe("vellum");
    expect(view.publicWsUrl).toBe("wss://x");
  });

  test("omits verificationToken even when set in config.json", () => {
    const view = readConfigView(configPath({ verificationToken: "secret" }));
    expect(view).not.toHaveProperty("verificationToken");
  });

  test("falls back to defaults for an invalid region", () => {
    // An invalid enum makes the whole parse fail, so the view is all-defaults.
    expect(readConfigView(configPath({ region: "moon-1" })).region).toBe(
      "us-east-1",
    );
  });
});

describe("applyConfigUpdate", () => {
  test("persists an edited region and preserves unrelated fields", () => {
    const path = configPath({
      publicWsUrl: "wss://x",
      verificationToken: "tok",
    });

    const view = applyConfigUpdate(path, {
      region: "eu-central-1",
      useVoiceMode: true,
    });
    expect(view.region).toBe("eu-central-1");
    expect(view.useVoiceMode).toBe(true);
    expect(view).not.toHaveProperty("verificationToken");

    // On disk: the edit merged in, and unrelated fields (including the token)
    // are preserved.
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      publicWsUrl: "wss://x",
      verificationToken: "tok",
      region: "eu-central-1",
      useVoiceMode: true,
    });
  });

  test("a single-field update leaves other editable fields intact", () => {
    const path = configPath({ useVoiceMode: true, region: "us-east-1" });
    const view = applyConfigUpdate(path, { region: "us-west-2" });
    expect(view.useVoiceMode).toBe(true);
    expect(view.region).toBe("us-west-2");
  });
});

describe("applyProviderChange", () => {
  test("persists the provider and preserves unrelated fields", () => {
    const path = configPath({ publicWsUrl: "wss://x", useVoiceMode: true });
    const view = applyProviderChange(path, { provider: "vellum" });
    expect(view.provider).toBe("vellum");
    expect(view.useVoiceMode).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      publicWsUrl: "wss://x",
      useVoiceMode: true,
      provider: "vellum",
    });
  });

  test("switching back to recall persists", () => {
    const path = configPath({ provider: "vellum" });
    expect(applyProviderChange(path, { provider: "recall" }).provider).toBe(
      "recall",
    );
  });
});
