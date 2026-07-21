/**
 * Tests for `daemon/meet-backend.ts` - the bot-runner backend selector and
 * Docker-availability probe.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectDockerAvailable,
  getMeetBotBackend,
  resetMeetBotBackendForTests,
  resolveDockerSocketPath,
  setMeetBotBackend,
} from "../meet-backend.js";

afterEach(() => {
  resetMeetBotBackendForTests();
  delete process.env.MEET_DOCKER_SOCKET;
});

describe("meet backend selector", () => {
  test("defaults to docker before init records a decision", () => {
    resetMeetBotBackendForTests();
    expect(getMeetBotBackend()).toBe("docker");
  });

  test("records and returns the resolved backend", () => {
    setMeetBotBackend("direct");
    expect(getMeetBotBackend()).toBe("direct");
    setMeetBotBackend("docker");
    expect(getMeetBotBackend()).toBe("docker");
  });
});

describe("resolveDockerSocketPath", () => {
  test("defaults to the standard engine socket", () => {
    delete process.env.MEET_DOCKER_SOCKET;
    expect(resolveDockerSocketPath()).toBe("/var/run/docker.sock");
  });

  test("honors the MEET_DOCKER_SOCKET override", () => {
    process.env.MEET_DOCKER_SOCKET = "/custom/docker.sock";
    expect(resolveDockerSocketPath()).toBe("/custom/docker.sock");
  });
});

describe("detectDockerAvailable", () => {
  test("resolves false for an unreachable socket instead of throwing", async () => {
    const bogus = join(tmpdir(), `no-such-docker-${Date.now()}.sock`);
    const available = await detectDockerAvailable(bogus);
    expect(available).toBe(false);
  });
});
