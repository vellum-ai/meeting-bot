/**
 * Tests for Recall API-key resolution.
 *
 * `resolveApiKey` resolves the key from the secure credential store via
 * `assistant credentials reveal`, and from nowhere else. In particular it must
 * NOT read the key from an environment variable, since an env var holding the
 * key would leak through the assistant's bash tool.
 *
 * `execSync` is mocked at the module level so the tests never shell out to the
 * real CLI; everything else in `node:child_process` is passed through.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { MeetingBotConfig } from "../config.ts";

const realChildProcess = await import("node:child_process");

let execSyncMode: "throw" | "value" = "throw";
let execSyncValue = "";

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execSync: mock((cmd: string, opts?: unknown) => {
    if (typeof cmd === "string" && cmd.includes("credentials reveal")) {
      if (execSyncMode === "throw") {
        throw new Error("assistant: command not found");
      }
      return execSyncValue;
    }
    return realChildProcess.execSync(cmd as string, opts as never);
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
    execSyncMode = "throw";
    execSyncValue = "";
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  test("returns the credential-store value", () => {
    execSyncMode = "value";
    execSyncValue = "store-key";
    expect(resolveApiKey(makeConfig())).toBe("store-key");
  });

  test("does not fall back to an environment variable", () => {
    // The store yields nothing (CLI unavailable) and an env var is set: the
    // key must still be treated as unresolved so it can never come from the
    // environment.
    execSyncMode = "throw";
    process.env.MEETING_BOT_API_KEY = "env-key";
    process.env.RECALL_API_KEY = "legacy-key";
    expect(() => resolveApiKey(makeConfig())).toThrow(/Recall API key not found/);
  });

  test("throws a descriptive error when the store is empty", () => {
    execSyncMode = "value";
    execSyncValue = "";
    expect(() => resolveApiKey(makeConfig())).toThrow(/Recall API key not found/);
  });
});
