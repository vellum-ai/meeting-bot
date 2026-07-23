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

describe("libraryCandidates / pulseModuleDir", () => {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");

  function fakeRoot(): string {
    const root = tmp();
    mkdirSync(join(root, "usr/lib/x86_64-linux-gnu/pulseaudio"), { recursive: true });
    mkdirSync(join(root, "usr/lib/x86_64-linux-gnu/pulse-17.0/modules"), { recursive: true });
    mkdirSync(join(root, "usr/local/lib"), { recursive: true });
    return root;
  }

  test("returns only existing lib dirs, including pulseaudio's private subdir", async () => {
    const { libraryCandidates } = await import("../path-env.ts");
    const root = fakeRoot();
    const dirs = libraryCandidates(root);
    expect(dirs).toContain(join(root, "usr/lib/x86_64-linux-gnu"));
    expect(dirs).toContain(join(root, "usr/lib/x86_64-linux-gnu/pulseaudio"));
    expect(dirs).toContain(join(root, "usr/local/lib"));
    expect(dirs).not.toContain(join(root, "usr/lib/aarch64-linux-gnu"));
  });

  test("includes the pulse modules dir so module support libs resolve", async () => {
    const { libraryCandidates } = await import("../path-env.ts");
    const root = fakeRoot();
    expect(libraryCandidates(root)).toContain(
      join(root, "usr/lib/x86_64-linux-gnu/pulse-17.0/modules"),
    );
  });

  test("finds pulseaudio's relocated module directory", async () => {
    const { pulseModuleDir } = await import("../path-env.ts");
    const root = fakeRoot();
    expect(pulseModuleDir(root)).toBe(
      join(root, "usr/lib/x86_64-linux-gnu/pulse-17.0/modules"),
    );
    expect(pulseModuleDir(tmp())).toBeNull();
  });

  test("finds a version-suffixed module dir outside the arch triplet", async () => {
    // Ubuntu 24.04 installs modules at usr/lib/pulse-16.1+dfsg1/modules.
    const { pulseModuleDir } = await import("../path-env.ts");
    const root = tmp();
    mkdirSync(join(root, "usr/lib/pulse-16.1+dfsg1/modules"), {
      recursive: true,
    });
    expect(pulseModuleDir(root)).toBe(
      join(root, "usr/lib/pulse-16.1+dfsg1/modules"),
    );
  });

  test("prependedLibraryPath puts relocated dirs first without duplicating", async () => {
    const { prependedLibraryPath } = await import("../path-env.ts");
    const a = tmp();
    const b = tmp();
    expect(prependedLibraryPath("/sys/lib", [a, b])).toBe(`${a}:${b}:/sys/lib`);
    expect(prependedLibraryPath(`${a}:/sys/lib`, [a, b])).toBe(`${b}:${a}:/sys/lib`);
    expect(prependedLibraryPath(undefined, [a])).toBe(a);
  });
});
