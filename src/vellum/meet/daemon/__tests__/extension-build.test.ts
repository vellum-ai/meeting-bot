/**
 * Tests for direct-mode extension building: a present dist is a no-op, a
 * missing dist is built from the sibling source tree via `bun run
 * scripts/build.ts`, failures are actionable, and the runner ensures the
 * extension before spawning a bot.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DirectBotRunner,
  ensureExtensionBuilt,
  type SpawnedProcess,
  type SpawnFn,
} from "../direct-bot-runner.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeProc(exitCode: number): SpawnedProcess {
  return {
    pid: 4242,
    exited: Promise.resolve(exitCode),
    stdout: null,
    stderr: null,
    kill: () => {},
  };
}

describe("ensureExtensionBuilt", () => {
  test("no-op when dist/manifest.json already exists", async () => {
    const dist = tmp("ext-dist-");
    writeFileSync(join(dist, "manifest.json"), "{}");
    let spawned = false;
    await ensureExtensionBuilt(dist, {
      spawn: ((..._args: unknown[]) => {
        spawned = true;
        return fakeProc(0);
      }) as unknown as SpawnFn,
    });
    expect(spawned).toBe(false);
  });

  test("builds via bun run scripts/build.ts when the dist is missing", async () => {
    const pkg = tmp("ext-pkg-");
    mkdirSync(join(pkg, "scripts"), { recursive: true });
    writeFileSync(join(pkg, "scripts", "build.ts"), "");
    const dist = join(pkg, "dist");

    const calls: Array<{ cmd: string[]; cwd?: string }> = [];
    const spawn: SpawnFn = (cmd, options) => {
      calls.push({ cmd, cwd: options.cwd });
      // Simulate the build producing the dist.
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "manifest.json"), "{}");
      return fakeProc(0);
    };

    await ensureExtensionBuilt(dist, { spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual(["bun", "run", "scripts/build.ts"]);
    expect(calls[0]?.cwd).toBe(pkg);
  });

  test("throws when the dist is missing and there is no build script", async () => {
    const dist = join(tmp("ext-none-"), "dist");
    const err = await ensureExtensionBuilt(dist).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("no build script");
  });

  test("throws when the build exits non-zero", async () => {
    const pkg = tmp("ext-pkg-");
    mkdirSync(join(pkg, "scripts"), { recursive: true });
    writeFileSync(join(pkg, "scripts", "build.ts"), "");
    const err = await ensureExtensionBuilt(join(pkg, "dist"), {
      spawn: (() => fakeProc(1)) as unknown as SpawnFn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("build failed");
  });
});

describe("DirectBotRunner extension ensure", () => {
  test("ensures the extension before spawning the bot, once across joins", async () => {
    const order: string[] = [];
    const spawn: SpawnFn = () => {
      order.push("spawn");
      return fakeProc(0);
    };
    const runner = new DirectBotRunner({
      spawn,
      allocatePort: async () => 40000,
      scratchRoot: tmp("runner-scratch-"),
      ensureExtension: async (extensionPath) => {
        order.push(`ensure:${extensionPath.length > 0 ? "path" : "empty"}`);
      },
    });

    await runner.run({ image: "x", env: {} });
    await runner.run({ image: "x", env: {} });

    // One ensure (shared latch), before the first spawn; both bots spawned.
    expect(order).toEqual(["ensure:path", "spawn", "spawn"]);
  });
});
