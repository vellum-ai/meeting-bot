/**
 * Tests for the legacy browser-bot gate.
 *
 * The gate decides whether the worker runs an `apt-get` browser-stack
 * install at plugin init and whether `/join` will spawn a bot at all, so
 * "off unless explicitly opted in" is the property that matters.
 */

import { describe, expect, test } from "bun:test";

import {
  LEGACY_BROWSER_BOT_ENV,
  legacyBrowserBotDisabledMessage,
  legacyBrowserBotEnabled,
} from "../vellum/legacy-browser-bot.ts";

describe("legacyBrowserBotEnabled", () => {
  test("is off when unset", () => {
    expect(legacyBrowserBotEnabled({})).toBe(false);
  });

  test('is on only for exactly "1"', () => {
    expect(legacyBrowserBotEnabled({ [LEGACY_BROWSER_BOT_ENV]: "1" })).toBe(
      true,
    );
    // Trimmed, so a stray newline from a shell export still counts.
    expect(legacyBrowserBotEnabled({ [LEGACY_BROWSER_BOT_ENV]: " 1\n" })).toBe(
      true,
    );
  });

  test("treats other truthy-looking values as off", () => {
    // Deliberately strict: the disabled state must not be reachable by
    // accident, and "true"/"yes" would invite a silent apt-get install.
    for (const value of ["true", "yes", "on", "0", "", "  "]) {
      expect(legacyBrowserBotEnabled({ [LEGACY_BROWSER_BOT_ENV]: value })).toBe(
        false,
      );
    }
  });
});

describe("legacyBrowserBotDisabledMessage", () => {
  test("names the cause, the alternative, and the escape hatch", () => {
    const message = legacyBrowserBotDisabledMessage();
    expect(message).toContain("recall");
    expect(message).toContain(LEGACY_BROWSER_BOT_ENV);
    // The reason has to be in the message: a bare "disabled" sends the
    // reader hunting for a config toggle that is not the real problem.
    expect(message).toMatch(/anonymous/i);
  });
});
