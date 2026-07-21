/**
 * `GET /x/plugins/meeting-bot/meetings`: meeting history for the config app.
 */

import { handleMeetingsGet } from "../src/app-routes.ts";

export async function GET(_request: Request): Promise<Response> {
  return handleMeetingsGet();
}
