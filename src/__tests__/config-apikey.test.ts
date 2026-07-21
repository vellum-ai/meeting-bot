/**
 * Tests for Recall API-key resolution.
 *
 * `resolveApiKey` resolves the key via the host's in-process
 * `resolveCredential`, and from nowhere else. In particular it must NOT read
 * the key from an environment variable, since an env var holding the key would
 * leak through the assistant's bash tool.
 *
 * `resolveCredential` is mocked at the module level so the tests never reach
 * the host; everything else in `@vellumai/plugin-api` is passed through.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { MeetingBotConfig } from "../config.ts";

const realPluginApi = await import("@vellumai/plugin-api");

let credentialMode: "throw" | "value" = "throw";
let credentialValue = "";
let lastRef: string | null = null;

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  resolveCredential: mock(async (ref: string) => {
    lastRef = ref;
    if (credentialMode === "throw") {
      throw new Error("credential not found");
    }
    return credentialValue;
  }),
}));

const { resolveApiKey } = await import("../config.ts");

function makeConfig(
  apiKeyCredential = "meeting-bot:api_key",
): MeetingBotConfig {
  return { apiKeyCredential } as MeetingBotConfig;
}

const ENV_KEYS = ["MEETING_BOT_API_KEY", "RECALL_API_KEY"];

describe("resolveApiKey", () => {
  beforeEach(() => {
    credentialMode = "throw";
    credentialValue = "";
    lastRef = null;
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  test("returns the resolved credential value", async () => {
    credentialMode = "value";
    credentialValue = "store-key";
    expect(await resolveApiKey(makeConfig())).toBe("store-key");
  });

  test("passes the credential as a slash-separated service/field ref", async () => {
    credentialMode = "value";
    credentialValue = "store-key";
    await resolveApiKey(makeConfig("recall:api_key"));
    expect(lastRef).toBe("recall/api_key");
  });

  test("does not fall back to an environment variable", async () => {
    // The store yields nothing and an env var is set: the key must still be
    // treated as unresolved so it can never come from the environment.
    credentialMode = "throw";
    process.env.MEETING_BOT_API_KEY = "env-key";
    process.env.RECALL_API_KEY = "legacy-key";
    await expect(resolveApiKey(makeConfig())).rejects.toThrow(
      /Recall API key not found/,
    );
  });

  test("throws a descriptive error when the credential is empty", async () => {
    credentialMode = "value";
    credentialValue = "";
    await expect(resolveApiKey(makeConfig())).rejects.toThrow(
      /Recall API key not found/,
    );
  });
});
