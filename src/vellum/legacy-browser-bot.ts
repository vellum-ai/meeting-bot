/**
 * Gate for the legacy self-hosted browser bot.
 *
 * The `vellum` provider used to join meetings by driving its own Chromium:
 * probe for a browser stack, `apt-get install` chromium/Xvfb/xdotool/
 * PulseAudio/ffmpeg when missing, then spawn a bot per meeting. That path
 * is superseded — anonymous browser joins are refused by Meet, and the
 * provider is moving to the platform's Velay ingress (`./velay/`).
 *
 * The code is not deleted yet, because nothing end-to-end replaces it. It
 * is disabled by default instead, so a plugin install no longer:
 *
 *   - runs `apt-get install` at init and on every provider switch, which
 *     mutates the host and costs minutes on a cold machine, and
 *   - spawns browser bots that cannot complete a join anyway.
 *
 * Set `VELLUM_MEET_LEGACY_BROWSER_BOT=1` to re-enable it for local work on
 * the vendored tree. Delete this module (and the tree it guards) once the
 * Velay path is working end to end.
 */

/** Env var that re-enables the legacy browser-bot path. */
export const LEGACY_BROWSER_BOT_ENV = "VELLUM_MEET_LEGACY_BROWSER_BOT";

/** Minimal env shape — avoids depending on Node's globals here. */
export type EnvLike = Record<string, string | undefined>;

/**
 * True when the legacy path is explicitly opted into. Anything other than
 * `"1"` — including unset — leaves it off, so the disabled state is never
 * reached by accident.
 */
export function legacyBrowserBotEnabled(
  env: EnvLike = process.env,
): boolean {
  return (env[LEGACY_BROWSER_BOT_ENV] ?? "").trim() === "1";
}

/**
 * Message returned when a join is attempted with the legacy path off.
 * Written once here so the worker's `/join` and its status tracker agree.
 */
export function legacyBrowserBotDisabledMessage(): string {
  return (
    "the vellum provider's self-hosted browser bot is disabled: Google Meet " +
    "refuses anonymous automated clients, so this path cannot complete a " +
    "join. Use the recall provider, or set " +
    `${LEGACY_BROWSER_BOT_ENV}=1 to re-enable it for local testing.`
  );
}
