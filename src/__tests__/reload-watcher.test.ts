/**
 * Tests for the data-dir reload handshake: request pickup, result write,
 * dedup by id, failure reporting, and leftover-request adoption.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RELOAD_REQUEST_FILE,
  RELOAD_RESULT_FILE,
  startReloadWatcher,
} from "../reload-watcher.ts";
import type { Logger } from "../realtime-server.ts";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "meeting-bot-reload-"));
}

function writeRequest(dir: string, id: string): void {
  writeFileSync(
    join(dir, RELOAD_REQUEST_FILE),
    JSON.stringify({ id, at: 0 }),
    "utf-8",
  );
}

function readResult(dir: string): { id: string; ok: boolean; note: string } | null {
  const path = join(dir, RELOAD_RESULT_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("startReloadWatcher", () => {
  test("handles a request: restarts, writes the result, removes the request", async () => {
    const dir = tmp();
    let restarts = 0;
    const watcher = startReloadWatcher({
      dataDir: dir,
      restart: async () => {
        restarts += 1;
        return "provider runtime restarted (vellum)";
      },
      logger: noopLogger,
      pollIntervalMs: 25,
    });
    try {
      writeRequest(dir, "req-1");
      await waitFor(() => readResult(dir) !== null);
      expect(readResult(dir)).toMatchObject({
        id: "req-1",
        ok: true,
        note: "provider runtime restarted (vellum)",
      });
      expect(restarts).toBe(1);
      expect(existsSync(join(dir, RELOAD_REQUEST_FILE))).toBe(false);
    } finally {
      watcher.stop();
    }
  });

  test("a failing restart reports ok=false with the reason", async () => {
    const dir = tmp();
    const watcher = startReloadWatcher({
      dataDir: dir,
      restart: async () => {
        throw new Error("boom");
      },
      logger: noopLogger,
      pollIntervalMs: 25,
    });
    try {
      writeRequest(dir, "req-2");
      await waitFor(() => readResult(dir) !== null);
      const result = readResult(dir)!;
      expect(result.ok).toBe(false);
      expect(result.note).toContain("boom");
    } finally {
      watcher.stop();
    }
  });

  test("distinct requests each restart; a re-observed id does not", async () => {
    const dir = tmp();
    let restarts = 0;
    const watcher = startReloadWatcher({
      dataDir: dir,
      restart: async () => {
        restarts += 1;
        return `restart ${restarts}`;
      },
      logger: noopLogger,
      pollIntervalMs: 25,
    });
    try {
      writeRequest(dir, "req-a");
      await waitFor(() => readResult(dir)?.id === "req-a");
      writeRequest(dir, "req-b");
      await waitFor(() => readResult(dir)?.id === "req-b");
      expect(restarts).toBe(2);
      // Re-writing an already-handled id is ignored.
      writeRequest(dir, "req-b");
      await new Promise((r) => setTimeout(r, 120));
      expect(restarts).toBe(2);
    } finally {
      watcher.stop();
    }
  });

  test("adopts a leftover request from before the watcher started", async () => {
    const dir = tmp();
    writeRequest(dir, "stale-req");
    let restarts = 0;
    const watcher = startReloadWatcher({
      dataDir: dir,
      restart: async () => {
        restarts += 1;
        return "restarted";
      },
      logger: noopLogger,
      pollIntervalMs: 25,
    });
    try {
      await new Promise((r) => setTimeout(r, 150));
      expect(restarts).toBe(0);
      expect(readResult(dir)).toBeNull();
    } finally {
      watcher.stop();
    }
  });
});
