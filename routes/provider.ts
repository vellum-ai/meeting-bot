/**
 * `POST /x/plugins/meeting-bot/provider`: switch the meeting provider
 * (recall or vellum). Deliberately separate from the settings PATCH: a
 * provider change carries side effects beyond a config write.
 */

import { handleProviderPost } from "../src/app-routes.ts";

export async function POST(request: Request): Promise<Response> {
  return handleProviderPost(request);
}
