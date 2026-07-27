/**
 * Unit tests for xdotool binary resolution.
 *
 * The resolver takes PATH as a parameter, so tests exercise both branches
 * deterministically: a PATH containing a real executable named xdotool,
 * and an empty PATH that forces the container fallback.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { defaultXdotoolBinary } from "../browser/xdotool-binary.js";

const binDir = mkdtempSync(join(tmpdir(), "xdotool-binary-test-"));
const fakeBinary = join(binDir, "xdotool");
writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
chmodSync(fakeBinary, 0o755);

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

describe("defaultXdotoolBinary", () => {
  test("resolves from the given PATH when present", () => {
    expect(defaultXdotoolBinary(binDir)).toBe(fakeBinary);
  });

  test("falls back to the container path when PATH has no xdotool", () => {
    expect(defaultXdotoolBinary("")).toBe("/usr/bin/xdotool");
  });
});
