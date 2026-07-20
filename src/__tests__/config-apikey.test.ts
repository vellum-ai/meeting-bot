/**
 * Tests for Recall API-key resolution.
 *
 * `resolveApiKey` resolves from the credential store first (via
 * `assistant credentials reveal`) and falls back to an environment variable
 * when the CLI is not reachable: the fallback that keeps the automatic voice
 * response working in process contexts without the `assistant` CLI on PATH.
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

const { resolveApiKey, credentialEnvVarNames } = await import("../config.ts");

function makeConfig(
  apiKeyCredential = "meeting-bot:api_key",
): MeetingBotConfig {
  return { apiKeyCredential } as MeetingBotConfig;
}

const ENV_KEYS = ["MEETING_BOT_API_KEY", "RECALL_API_KEY"];

describe("credentialEnvVarNames", () => {
  test("derives an env var name from the credential name", () => {
    expect(credentialEnvVarNames("meeting-bot", "api_key")).toEqual([
      "MEETING_BOT_API_KEY",
      "RECALL_API_KEY",
    ]);
  });

  test("de-duplicates when the derived name is the legacy name", () => {
    expect(credentialEnvVarNames("recall", "api_key")).toEqual([
      "RECALL_API_KEY",
    ]);
  });
});

describe("resolveApiKey", () => {
  beforeEach(() => {
    execSyncMode = "throw";
    execSyncValue = "";
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  test("returns the credential-store value when available", () => {
    execSyncMode = "value";
    execSyncValue = "store-key";
    process.env.MEETING_BOT_API_KEY = "env-key";
    // The store is primary: env should not shadow a live credential.
    expect(resolveApiKey(makeConfig())).toBe("store-key");
  });

  test("falls back to the env var when the CLI is unavailable", () => {
    execSyncMode = "throw";
    process.env.MEETING_BOT_API_KEY = "env-key";
    expect(resolveApiKey(makeConfig())).toBe("env-key");
  });

  test("honors the legacy RECALL_API_KEY env var", () => {
    execSyncMode = "throw";
    process.env.RECALL_API_KEY = "legacy-key";
    expect(resolveApiKey(makeConfig())).toBe("legacy-key");
  });

  test("throws a descriptive error when no source yields a value", () => {
    execSyncMode = "throw";
    expect(() => resolveApiKey(makeConfig())).toThrow(/Recall API key not found/);
  });
});
