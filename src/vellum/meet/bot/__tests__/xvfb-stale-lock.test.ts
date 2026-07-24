/**
 * Regression test for the stale-lock trap: a lingering /tmp/.X<N>-lock
 * whose recorded pid is alive but is NOT an X server (SIGKILLed Xvfb plus
 * pid recycling) must not be trusted. startXvfb has to detect that nothing
 * accepts on the display's socket, clear the lock, spawn a real server,
 * and only resolve once the socket connects; a second call must reuse the
 * live server instead of spawning again.
 *
 * Runs only where an Xvfb binary is present (Linux CI / the bot
 * container); skipped elsewhere so macOS developers are not forced to
 * install X.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";

import { startXvfb, stopXvfb } from "../browser/xvfb.ts";

const hasXvfb = Bun.which("Xvfb", { PATH: process.env.PATH ?? "" }) !== null;

/** Display reserved for this test; unusual number to avoid collisions. */
const DISPLAY = ":93";
const LOCK = "/tmp/.X93-lock";
const SOCK = "/tmp/.X11-unix/X93";

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("startXvfb stale-lock recovery", () => {
  test.skipIf(!hasXvfb)(
    "spawns a real server despite a stale lock with a live foreign pid, then reuses it",
    async () => {
      rmSync(LOCK, { force: true });
      rmSync(SOCK, { force: true });
      // Pid 1 is always alive and is never an X server for this display.
      writeFileSync(LOCK, "         1\n");

      const first = await startXvfb(DISPLAY);
      try {
        expect(first.process).not.toBeNull();
        expect(await canConnect(SOCK)).toBe(true);

        const second = await startXvfb(DISPLAY);
        expect(second.process).toBeNull();
      } finally {
        await stopXvfb(first);
        rmSync(LOCK, { force: true });
      }
      expect(existsSync(SOCK)).toBe(false);
    },
    30_000,
  );
});
