/**
 * Google account credentials for the vellum provider's bot.
 *
 * Meet hard-denies anonymous automated clients at knock submission (see
 * `src/vellum/meet/bot/AGENTS.md`), so the vellum bot has to sign in like
 * any other participant. The account is a dedicated bot account the
 * operator provisions — the same shape Recall uses internally — not the
 * end user's personal Google account.
 *
 * ## Storage
 *
 * Values live ONLY in the credential store, under the plugin's existing
 * `meeting-bot` service alongside the Recall `api_key`:
 *
 *   meeting-bot/google_email
 *   meeting-bot/google_password
 *
 * Nothing about them is written to `config.json` — not the values, and
 * deliberately not a credential id or reference either. The field names
 * are constants in this module, so the config file needs no pointer to
 * find them, and a leaked config discloses nothing at all.
 *
 * ## Reads vs writes
 *
 * Reads go through the host's in-process `resolveCredential`. Writes shell
 * out to `assistant credentials set`, because the plugin API exposes no
 * write surface outside a tool context. That spawn MUST stay asynchronous:
 * the CLI reaches the daemon over IPC, so a synchronous `execSync` from a
 * daemon route deadlocks until the IPC times out (~60s) — the same trap
 * documented on `resolveApiKey` in `config.ts`.
 */

import { z } from "zod";
import { resolveCredential } from "@vellumai/plugin-api";

import { CREDENTIAL_SERVICE } from "./config.ts";
export {
  GOOGLE_ACCOUNT_EMAIL_ENV,
  GOOGLE_ACCOUNT_PASSWORD_ENV,
  googleAccountMissingMessage,
} from "./vellum/google-account-env.ts";

/**
 * Body schema for the dashboard's credential write. Both fields optional
 * so the form can update one without the other, but at least one must be
 * present and neither may be blank — a blank would silently store an
 * empty credential that then reads back as "configured".
 */
export const GoogleCredentialsUpdateSchema = z
  .object({
    email: z.string().trim().min(1).email().optional(),
    password: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.email !== undefined || v.password !== undefined, {
    message: "provide an email, a password, or both",
  });

export type GoogleCredentialsUpdate = z.infer<
  typeof GoogleCredentialsUpdateSchema
>;

/** Credential field holding the bot account's email address. */
export const GOOGLE_EMAIL_FIELD = "google_email";
/** Credential field holding the bot account's password. */
export const GOOGLE_PASSWORD_FIELD = "google_password";

/** Resolved bot-account login. */
export interface GoogleCredentials {
  email: string;
  password: string;
}

/** Which of the two fields currently hold a value. Never carries values. */
export interface GoogleCredentialsStatus {
  email: boolean;
  password: boolean;
  /** True only when both are present — the gate the join path checks. */
  complete: boolean;
}

/** Read one field, returning null when absent or empty rather than throwing. */
async function readField(field: string): Promise<string | null> {
  try {
    const value = (
      await resolveCredential(`${CREDENTIAL_SERVICE}/${field}`)
    ).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Report which credential fields are populated, without revealing them.
 * Used by the dashboard to render "configured / not configured" state.
 */
export async function googleCredentialsStatus(): Promise<GoogleCredentialsStatus> {
  const [email, password] = await Promise.all([
    readField(GOOGLE_EMAIL_FIELD),
    readField(GOOGLE_PASSWORD_FIELD),
  ]);
  return {
    email: email !== null,
    password: password !== null,
    complete: email !== null && password !== null,
  };
}

/**
 * Human-readable instructions for storing the credentials by hand. Shared
 * by every error path so the CLI form is written in exactly one place.
 */
export function googleCredentialsSetupHint(): string {
  return (
    `Store them with:\n` +
    `  assistant credentials set --service ${CREDENTIAL_SERVICE} --field ${GOOGLE_EMAIL_FIELD} <bot@example.com>\n` +
    `  assistant credentials set --service ${CREDENTIAL_SERVICE} --field ${GOOGLE_PASSWORD_FIELD} <password>\n` +
    `or set them from the meeting-bot dashboard.`
  );
}

/**
 * Resolve both credentials. Throws a descriptive error naming the missing
 * field(s) — the vellum join path surfaces this verbatim, so it has to be
 * actionable on its own.
 */
export async function resolveGoogleCredentials(): Promise<GoogleCredentials> {
  const [email, password] = await Promise.all([
    readField(GOOGLE_EMAIL_FIELD),
    readField(GOOGLE_PASSWORD_FIELD),
  ]);
  const missing: string[] = [];
  if (email === null) missing.push(GOOGLE_EMAIL_FIELD);
  if (password === null) missing.push(GOOGLE_PASSWORD_FIELD);
  if (missing.length > 0) {
    throw new Error(
      `the vellum provider needs a Google account for its bot, but ` +
        `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not stored. ` +
        googleCredentialsSetupHint(),
    );
  }
  return { email: email!, password: password! };
}

/** Injectable spawn seam so tests never invoke the real CLI. */
export type CredentialSetSpawn = (
  args: readonly string[],
) => Promise<{ exitCode: number; stderr: string }>;

/** Default spawn: async by design — see the module header on the deadlock. */
const defaultSpawn: CredentialSetSpawn = async (args) => {
  const proc = Bun.spawn(["assistant", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
};

/** Raised when a credential write fails; carries no secret material. */
export class GoogleCredentialWriteError extends Error {}

/**
 * Persist one or both credential fields. Fields left undefined are not
 * touched, so the dashboard can update just the password without making
 * the user retype the email.
 *
 * Values are passed as CLI arguments because that is the only interface
 * `assistant credentials set` documents. On a shared host that makes them
 * briefly visible in the process table — acceptable for a stopgap on a
 * single-tenant assistant host, and worth revisiting if the CLI grows a
 * stdin form.
 */
export async function storeGoogleCredentials(
  values: { email?: string; password?: string },
  deps: { spawn?: CredentialSetSpawn } = {},
): Promise<void> {
  const spawn = deps.spawn ?? defaultSpawn;
  const writes: Array<{ field: string; value: string }> = [];
  if (values.email !== undefined) {
    writes.push({ field: GOOGLE_EMAIL_FIELD, value: values.email });
  }
  if (values.password !== undefined) {
    writes.push({ field: GOOGLE_PASSWORD_FIELD, value: values.password });
  }
  if (writes.length === 0) {
    throw new GoogleCredentialWriteError(
      "nothing to store: provide an email, a password, or both",
    );
  }

  for (const { field, value } of writes) {
    const { exitCode, stderr } = await spawn([
      "credentials",
      "set",
      "--service",
      CREDENTIAL_SERVICE,
      "--field",
      field,
      value,
    ]);
    if (exitCode !== 0) {
      // Never echo `value` — the stderr from the CLI is safe, the input is not.
      throw new GoogleCredentialWriteError(
        `failed to store ${CREDENTIAL_SERVICE}/${field} (exit ${exitCode})` +
          (stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""),
      );
    }
  }
}
