/**
 * `POST /x/plugins/meeting-bot/provider`: switch the meeting provider
 * (recall or vellum). Deliberately separate from the settings PATCH: after
 * the config write, the old provider runtime is torn down and the new one
 * spun up immediately. Posting the active provider bounces its runtime.
 */

import { handleProviderPost } from "../src/app-routes.ts";

export async function POST(request: Request): Promise<Response> {
  return handleProviderPost(request);
}
