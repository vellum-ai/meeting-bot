/**
 * Tests for direct-mode NMH manifest registration: renders the manifest
 * into the meeting profile's NativeMessagingHosts dir with the extension
 * id derived from the built extension's key and the host path pointing at
 * the plugin tree's shim, and fails with an actionable message when the
 * extension dist is missing.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureNmhManifestRegistered } from "../native-messaging/register-manifest.js";

/** Throwaway RSA-2048 SPKI key, shared with render-nmh-manifest.test.ts. */
const SAMPLE_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7HeRDjffv54OgiXEqgqmwhpIo9cruNnF3vscK/Ubn8vENJPp4TSUP2ZVfoWBUVONT5HtKvkYsJJjavokdGMuaRKm9xfdri/WWB+qJRePsGEdTYtNxD5Vrw+c5X6g3S0irNLbqTWGM9++Xn67hYSOKHdDVeKWZGbC6PdqYrTOaB1YHLKp+MulWMgoE4bDc+aWc58LOmhngAbRWreofNM/9Xomazm2TJ5/2zYikaEpRCT1JC3zpLTGfuRroZ2Ln5ut3zphp1aa1z4smViwsFVLUnhLKgWwSv2xPkRRHv5CE5FBDXjvgHNernlD9hn3EZisq3u4Z09C6D2qayC5/IxecQIDAQAB";
const SAMPLE_EXT_ID = "ckneaobnfimaenmllkigpibjgkaeolnf";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeExtensionDist(): string {
  const dist = tmp("nmh-ext-");
  writeFileSync(
    join(dist, "manifest.json"),
    JSON.stringify({ name: "ext", key: SAMPLE_KEY }),
  );
  return dist;
}

describe("ensureNmhManifestRegistered", () => {
  test("writes the manifest into the profile with the derived id and plugin-tree shim path", async () => {
    const userDataDir = tmp("nmh-udd-");
    const logs: string[] = [];

    await ensureNmhManifestRegistered({
      userDataDir,
      extensionPath: fakeExtensionDist(),
      logInfo: (m) => logs.push(m),
    });

    const written = JSON.parse(
      readFileSync(
        join(userDataDir, "NativeMessagingHosts", "com.vellum.meet.json"),
        "utf8",
      ),
    ) as { name: string; path: string; allowed_origins: string[] };
    expect(written.name).toBe("com.vellum.meet");
    expect(written.allowed_origins).toEqual([
      `chrome-extension://${SAMPLE_EXT_ID}/`,
    ]);
    // The host path must be the shim in THIS tree, not the container path
    // baked into the template.
    expect(written.path.endsWith("/native-messaging/nmh-shim.ts")).toBe(true);
    expect(written.path.startsWith("/app/")).toBe(false);
    expect(logs.join("\n")).toContain("registered native-messaging host");
  });

  test("throws an actionable error when the extension dist is missing", async () => {
    const userDataDir = tmp("nmh-udd-");
    const missing = join(tmp("nmh-missing-"), "dist");
    const err = await ensureNmhManifestRegistered({
      userDataDir,
      extensionPath: missing,
      logInfo: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("extension not found");
    expect((err as Error).message).toContain(missing);
  });

  test("throws when the extension manifest carries no key", async () => {
    const userDataDir = tmp("nmh-udd-");
    const dist = tmp("nmh-ext-");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "manifest.json"), JSON.stringify({ name: "x" }));
    const err = await ensureNmhManifestRegistered({
      userDataDir,
      extensionPath: dist,
      logInfo: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('no "key"');
  });
});
