/**
 * Tests for Google bot-account credential handling.
 *
 * The credential-store read path needs the host's `resolveCredential`, so
 * these tests focus on the parts that are exercisable in isolation: the
 * request schema, the write path (with an injected spawn), and the
 * env-var transport shared by the worker and the bot.
 */

import { describe, expect, test } from "bun:test";

import {
  GOOGLE_EMAIL_FIELD,
  GOOGLE_PASSWORD_FIELD,
  GoogleCredentialsUpdateSchema,
  GoogleCredentialWriteError,
  googleCredentialsSetupHint,
  storeGoogleCredentials,
  type CredentialSetSpawn,
} from "../google-credentials.ts";
import {
  GOOGLE_ACCOUNT_EMAIL_ENV,
  GOOGLE_ACCOUNT_PASSWORD_ENV,
  googleAccountBotEnv,
  googleAccountMissingMessage,
  hasGoogleAccountEnv,
  readGoogleAccountEnv,
} from "../vellum/google-account-env.ts";

/** Record the argv of every spawn without running anything. */
function recordingSpawn(exitCode = 0, stderr = ""): {
  spawn: CredentialSetSpawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn: CredentialSetSpawn = async (args) => {
    calls.push([...args]);
    return { exitCode, stderr };
  };
  return { spawn, calls };
}

describe("GoogleCredentialsUpdateSchema", () => {
  test("accepts either field alone or both", () => {
    expect(
      GoogleCredentialsUpdateSchema.safeParse({ email: "bot@example.com" })
        .success,
    ).toBe(true);
    expect(
      GoogleCredentialsUpdateSchema.safeParse({ password: "pw" }).success,
    ).toBe(true);
    expect(
      GoogleCredentialsUpdateSchema.safeParse({
        email: "bot@example.com",
        password: "pw",
      }).success,
    ).toBe(true);
  });

  test("rejects an empty body, blanks, and a malformed email", () => {
    expect(GoogleCredentialsUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      GoogleCredentialsUpdateSchema.safeParse({ password: "" }).success,
    ).toBe(false);
    expect(
      GoogleCredentialsUpdateSchema.safeParse({ email: "not-an-email" }).success,
    ).toBe(false);
  });

  test("rejects unknown fields so a typo cannot silently no-op", () => {
    expect(
      GoogleCredentialsUpdateSchema.safeParse({
        email: "bot@example.com",
        passwrd: "typo",
      }).success,
    ).toBe(false);
  });
});

describe("storeGoogleCredentials", () => {
  test("writes each supplied field to the meeting-bot service", async () => {
    const { spawn, calls } = recordingSpawn();
    await storeGoogleCredentials(
      { email: "bot@example.com", password: "s3cret" },
      { spawn },
    );

    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual([
      "credentials",
      "set",
      "--service",
      "meeting-bot",
      "--field",
      GOOGLE_EMAIL_FIELD,
      "bot@example.com",
    ]);
    expect(calls[1]![5]).toBe(GOOGLE_PASSWORD_FIELD);
    expect(calls[1]![6]).toBe("s3cret");
  });

  test("leaves the untouched field alone", async () => {
    const { spawn, calls } = recordingSpawn();
    await storeGoogleCredentials({ password: "only-this" }, { spawn });
    expect(calls.length).toBe(1);
    expect(calls[0]![5]).toBe(GOOGLE_PASSWORD_FIELD);
  });

  test("refuses an empty update", async () => {
    const { spawn, calls } = recordingSpawn();
    await expect(storeGoogleCredentials({}, { spawn })).rejects.toBeInstanceOf(
      GoogleCredentialWriteError,
    );
    expect(calls.length).toBe(0);
  });

  test("surfaces a CLI failure without echoing the secret", async () => {
    const { spawn } = recordingSpawn(1, "vault sealed");
    let message = "";
    try {
      await storeGoogleCredentials({ password: "super-secret" }, { spawn });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("vault sealed");
    expect(message).toContain(GOOGLE_PASSWORD_FIELD);
    // The value must never appear in an error surfaced to the client.
    expect(message).not.toContain("super-secret");
  });
});

describe("google account env transport", () => {
  const full = {
    [GOOGLE_ACCOUNT_EMAIL_ENV]: "bot@example.com",
    [GOOGLE_ACCOUNT_PASSWORD_ENV]: "s3cret",
  };

  test("detects a complete account", () => {
    expect(hasGoogleAccountEnv(full)).toBe(true);
    expect(readGoogleAccountEnv(full)).toEqual({
      email: "bot@example.com",
      password: "s3cret",
    });
  });

  test("treats a half-configured or blank account as absent", () => {
    expect(hasGoogleAccountEnv({})).toBe(false);
    expect(
      hasGoogleAccountEnv({ [GOOGLE_ACCOUNT_EMAIL_ENV]: "bot@example.com" }),
    ).toBe(false);
    expect(
      hasGoogleAccountEnv({ ...full, [GOOGLE_ACCOUNT_PASSWORD_ENV]: "   " }),
    ).toBe(false);
    expect(readGoogleAccountEnv({})).toBeNull();
  });

  test("bot env spread is empty when unconfigured and populated when set", () => {
    expect(googleAccountBotEnv({})).toEqual({});
    expect(googleAccountBotEnv(full)).toEqual(full);
  });

  test("the missing-account message names the fix", () => {
    const msg = googleAccountMissingMessage();
    expect(msg).toContain("google_email");
    expect(msg).toContain("google_password");
    expect(msg).toContain("dashboard");
  });

  test("the setup hint names both credential fields", () => {
    const hint = googleCredentialsSetupHint();
    expect(hint).toContain(GOOGLE_EMAIL_FIELD);
    expect(hint).toContain(GOOGLE_PASSWORD_FIELD);
  });
});
