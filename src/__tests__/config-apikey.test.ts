/**
 * Tests for Recall API-key resolution.
 *
 * `resolveApiKey` resolves the key via the host's in-process
 * `resolveCredential` from a single fixed credential (`meeting-bot/api_key`),
 * and from nowhere else. In particular it must NOT read the key from an
 * environment variable, since an env var holding the key would leak through
 * the assistant's bash tool.
 *
 * `resolveCredential` is mocked at the module level so the tests never reach
 * the host; everything else in `@vellumai/plugin-api` is passed through.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
    expect(await resolveApiKey()).toBe("store-key");
  });

  test("resolves the fixed meeting-bot/api_key credential", async () => {
    credentialMode = "value";
    credentialValue = "store-key";
    await resolveApiKey();
    expect(lastRef).toBe("meeting-bot/api_key");
  });

  test("does not fall back to an environment variable", async () => {
    // The store yields nothing and an env var is set: the key must still be
    // treated as unresolved so it can never come from the environment.
    credentialMode = "throw";
    process.env.MEETING_BOT_API_KEY = "env-key";
    process.env.RECALL_API_KEY = "legacy-key";
    await expect(resolveApiKey()).rejects.toThrow(/Recall API key not found/);
  });

  test("throws a descriptive error when the credential is empty", async () => {
    credentialMode = "value";
    credentialValue = "";
    await expect(resolveApiKey()).rejects.toThrow(/Recall API key not found/);
  });
});
