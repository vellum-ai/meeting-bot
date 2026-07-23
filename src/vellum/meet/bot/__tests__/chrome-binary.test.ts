/**
 * Tests for the browser-binary resolution used by the chrome launcher: the
 * CHROME_BINARY env override wins, otherwise the binary is found on PATH
 * (the assistant image installs chromium under a relocated apt root, so a
 * hardcoded /usr/bin/chromium does not exist there), with the container
 * path as the last resort.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultChromeBinary } from "../browser/chrome-launcher.ts";

const savedPath = process.env.PATH;
const savedOverride = process.env.CHROME_BINARY;
const savedAptRoot = process.env.VELLUM_APT_DATA_ROOT;

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedOverride === undefined) delete process.env.CHROME_BINARY;
  else process.env.CHROME_BINARY = savedOverride;
  if (savedAptRoot === undefined) delete process.env.VELLUM_APT_DATA_ROOT;
  else process.env.VELLUM_APT_DATA_ROOT = savedAptRoot;
});

function fakeBinDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-bot-chrome-"));
  const bin = join(dir, name);
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return dir;
}

describe("defaultChromeBinary", () => {
  test("CHROME_BINARY env override wins over PATH", () => {
    process.env.CHROME_BINARY = "/custom/chromium";
    expect(defaultChromeBinary()).toBe("/custom/chromium");
  });

  test("resolves chromium from PATH when no relocated root exists", () => {
    delete process.env.CHROME_BINARY;
    process.env.VELLUM_APT_DATA_ROOT = mkdtempSync(
      join(tmpdir(), "meeting-bot-noroot-"),
    );
    const dir = fakeBinDir("chromium");
    process.env.PATH = dir;
    expect(defaultChromeBinary()).toBe(join(dir, "chromium"));
  });

  test("prefers the relocated real binary over the PATH wrapper", () => {
    // Under a relocated apt root, bin/chromium on PATH is Debian's wrapper
    // script, which fails sourcing /etc/chromium.d/* at its absolute path.
    // The resolver must pick the real ELF under the root instead.
    delete process.env.CHROME_BINARY;
    const root = mkdtempSync(join(tmpdir(), "meeting-bot-aptroot-"));
    const real = join(root, "usr/lib/chromium/chromium");
    mkdirSync(join(root, "usr/lib/chromium"), { recursive: true });
    writeFileSync(real, "");
    chmodSync(real, 0o755);
    process.env.VELLUM_APT_DATA_ROOT = root;
    process.env.PATH = fakeBinDir("chromium");
    expect(defaultChromeBinary()).toBe(real);
  });

  test("CHROME_BINARY wins over the relocated real binary too", () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-bot-aptroot-"));
    mkdirSync(join(root, "usr/lib/chromium"), { recursive: true });
    writeFileSync(join(root, "usr/lib/chromium/chromium"), "");
    process.env.VELLUM_APT_DATA_ROOT = root;
    process.env.CHROME_BINARY = "/custom/chromium";
    expect(defaultChromeBinary()).toBe("/custom/chromium");
  });

  test("falls back to the container path when nothing is on PATH", () => {
    delete process.env.CHROME_BINARY;
    process.env.VELLUM_APT_DATA_ROOT = mkdtempSync(
      join(tmpdir(), "meeting-bot-noroot-"),
    );
    const empty = mkdtempSync(join(tmpdir(), "meeting-bot-empty-"));
    mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;
    expect(defaultChromeBinary()).toBe("/usr/bin/chromium");
  });
});
