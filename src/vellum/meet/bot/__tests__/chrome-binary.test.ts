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

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedOverride === undefined) delete process.env.CHROME_BINARY;
  else process.env.CHROME_BINARY = savedOverride;
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

  test("resolves chromium from PATH (relocated apt roots)", () => {
    delete process.env.CHROME_BINARY;
    const dir = fakeBinDir("chromium");
    process.env.PATH = dir;
    expect(defaultChromeBinary()).toBe(join(dir, "chromium"));
  });

  test("falls back to the container path when nothing is on PATH", () => {
    delete process.env.CHROME_BINARY;
    const empty = mkdtempSync(join(tmpdir(), "meeting-bot-empty-"));
    mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;
    expect(defaultChromeBinary()).toBe("/usr/bin/chromium");
  });
});
