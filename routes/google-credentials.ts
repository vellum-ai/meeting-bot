/**
 * Google bot-account credential routes, under
 * `/x/plugins/meeting-bot/google-credentials`:
 *   GET  reports which fields are configured (booleans only, never values)
 *   POST stores the email and/or password in the credential store
 *
 * Separate from the settings routes on purpose: settings writes land in
 * `config.json`, and these values must never be written there.
 */

import {
  handleGoogleCredentialsGet,
  handleGoogleCredentialsPost,
} from "../src/app-routes.ts";

export async function GET(_request: Request): Promise<Response> {
  return handleGoogleCredentialsGet();
}

export async function POST(request: Request): Promise<Response> {
  return handleGoogleCredentialsPost(request);
}
