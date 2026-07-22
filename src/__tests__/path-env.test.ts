/**
 * Tests for the PATH augmentation helper: existing entries keep priority,
 * only directories that exist get appended, and nothing is duplicated.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { augmentedPath } from "../path-env.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "meeting-bot-path-"));
}

describe("augmentedPath", () => {
  test("appends missing candidate dirs that exist on disk", () => {
    const extra = tmp();
    expect(augmentedPath("/original/bin", [extra])).toBe(`/original/bin:${extra}`);
  });

  test("skips candidates that do not exist", () => {
    expect(
      augmentedPath("/original/bin", ["/definitely/not/a/real/dir-42"]),
    ).toBe("/original/bin");
  });

  test("never duplicates an entry already on the PATH", () => {
    const extra = tmp();
    expect(augmentedPath(`/a:${extra}`, [extra])).toBe(`/a:${extra}`);
  });

  test("existing PATH order is preserved and candidates go last", () => {
    const extraA = tmp();
    const extraB = tmp();
    expect(augmentedPath("/z:/a", [extraA, extraB])).toBe(
      `/z:/a:${extraA}:${extraB}`,
    );
  });

  test("handles an unset or empty PATH", () => {
    const extra = tmp();
    expect(augmentedPath(undefined, [extra])).toBe(extra);
    expect(augmentedPath("", [extra])).toBe(extra);
  });
});
