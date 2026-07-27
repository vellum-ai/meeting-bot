/**
 * Environment-variable transport for the bot's Google account.
 *
 * Deliberately dependency-free: the Vellum Runtime worker and the bot both
 * import this, and neither can pull in `@vellumai/plugin-api`'s credential
 * resolution (that only works in the daemon process where the plugin's
 * hooks run — see `src/google-credentials.ts`).
 *
 * The daemon resolves the credential-store values once at runtime start and
 * injects them into the worker's environment; the worker forwards them into
 * each bot's environment. Environment (rather than argv) is the transport
 * because a child's argv is world-readable via `ps`, while its environment
 * is not.
 */

/** Env var holding the bot account's email address. */
export const GOOGLE_ACCOUNT_EMAIL_ENV = "GOOGLE_ACCOUNT_EMAIL";
/** Env var holding the bot account's password. */
export const GOOGLE_ACCOUNT_PASSWORD_ENV = "GOOGLE_ACCOUNT_PASSWORD";

/** Minimal env shape — avoids depending on Node's global types here. */
export type EnvLike = Record<string, string | undefined>;

/** True when both account env vars are present and non-empty. */
export function hasGoogleAccountEnv(env: EnvLike): boolean {
  return (
    (env[GOOGLE_ACCOUNT_EMAIL_ENV] ?? "").trim().length > 0 &&
    (env[GOOGLE_ACCOUNT_PASSWORD_ENV] ?? "").trim().length > 0
  );
}

/**
 * Read the account out of the environment, or null when either half is
 * missing. Callers that need to fail loudly should use
 * {@link hasGoogleAccountEnv} plus {@link googleAccountMissingMessage}.
 */
export function readGoogleAccountEnv(
  env: EnvLike,
): { email: string; password: string } | null {
  if (!hasGoogleAccountEnv(env)) return null;
  return {
    email: (env[GOOGLE_ACCOUNT_EMAIL_ENV] ?? "").trim(),
    password: env[GOOGLE_ACCOUNT_PASSWORD_ENV] ?? "",
  };
}

/**
 * The subset of a bot's environment carrying the Google account, ready to
 * spread into a spawn env. Empty when the account is not configured, so
 * spreading it is always safe.
 */
export function googleAccountBotEnv(env: EnvLike): Record<string, string> {
  const account = readGoogleAccountEnv(env);
  if (account === null) return {};
  return {
    [GOOGLE_ACCOUNT_EMAIL_ENV]: account.email,
    [GOOGLE_ACCOUNT_PASSWORD_ENV]: account.password,
  };
}

/**
 * The refusal message shown when a vellum join is attempted without an
 * account. Written once here so the worker's `/join`, the bot, and the
 * dashboard all say the same thing.
 */
export function googleAccountMissingMessage(): string {
  return (
    "the vellum provider needs a Google account for its bot before it can " +
    "join. Google refuses anonymous automated clients, so the bot signs in " +
    "as a dedicated account you provision. Set it from the meeting-bot " +
    "dashboard, or store meeting-bot/google_email and " +
    "meeting-bot/google_password in the credential store, then restart the " +
    "provider runtime."
  );
}
