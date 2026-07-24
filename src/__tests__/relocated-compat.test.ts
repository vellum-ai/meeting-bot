/**
 * Tests for the relocated-root compat symlinks: created only when the
 * system path is absent and the relocated equivalent exists, existing
 * entries always win, and failures are reported rather than thrown.
 */

import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureRelocatedCompatLinks } from "../vellum/relocated-compat.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("ensureRelocatedCompatLinks", () => {
  test("links each missing system path to its relocated equivalent", () => {
    const root = tmp("compat-root-");
    const prefix = tmp("compat-sys-");
    mkdirSync(join(root, "usr/bin"), { recursive: true });
    writeFileSync(join(root, "usr/bin/xkbcomp"), "");
    mkdirSync(join(root, "usr/share/X11/xkb"), { recursive: true });

    const report = ensureRelocatedCompatLinks({ root, systemPrefix: prefix });

    expect(report.failed).toEqual([]);
    expect(report.created).toHaveLength(2);
    expect(readlinkSync(join(prefix, "usr/bin/xkbcomp"))).toBe(
      join(root, "usr/bin/xkbcomp"),
    );
    expect(readlinkSync(join(prefix, "usr/share/X11/xkb"))).toBe(
      join(root, "usr/share/X11/xkb"),
    );
  });

  test("skips paths with no relocated equivalent and existing system entries", () => {
    const root = tmp("compat-root-");
    const prefix = tmp("compat-sys-");
    // Relocated root has only xkbcomp; the system already has its own.
    mkdirSync(join(root, "usr/bin"), { recursive: true });
    writeFileSync(join(root, "usr/bin/xkbcomp"), "");
    mkdirSync(join(prefix, "usr/bin"), { recursive: true });
    writeFileSync(join(prefix, "usr/bin/xkbcomp"), "system copy");

    const report = ensureRelocatedCompatLinks({ root, systemPrefix: prefix });

    expect(report.created).toEqual([]);
    expect(report.failed).toEqual([]);
    // The system entry is untouched (still a regular file, not a link).
    expect(lstatSync(join(prefix, "usr/bin/xkbcomp")).isSymbolicLink()).toBe(
      false,
    );
  });

  test("is idempotent across repeated runs", () => {
    const root = tmp("compat-root-");
    const prefix = tmp("compat-sys-");
    mkdirSync(join(root, "etc/chromium.d"), { recursive: true });

    const first = ensureRelocatedCompatLinks({ root, systemPrefix: prefix });
    expect(first.created).toHaveLength(1);
    const second = ensureRelocatedCompatLinks({ root, systemPrefix: prefix });
    expect(second.created).toEqual([]);
    expect(second.failed).toEqual([]);
  });

  test("reports a failure instead of throwing when the link cannot be created", () => {
    const root = tmp("compat-root-");
    const prefix = tmp("compat-sys-");
    mkdirSync(join(root, "usr/bin"), { recursive: true });
    writeFileSync(join(root, "usr/bin/xkbcomp"), "");
    // Occupy the parent path with a FILE so mkdir/symlink under it fails.
    mkdirSync(join(prefix, "usr"), { recursive: true });
    writeFileSync(join(prefix, "usr/bin"), "not a directory");

    const report = ensureRelocatedCompatLinks({ root, systemPrefix: prefix });

    expect(report.created).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.link).toBe(join(prefix, "usr/bin/xkbcomp"));
    expect(report.failed[0]?.error.length).toBeGreaterThan(0);
  });
});
