/**
 * `POST /x/plugins/meeting-bot/join`: start a join for a pasted meeting
 * link (the dashboard's Join button). Runs the configured provider's join
 * flow and returns once the attempt has been started; progress appears in
 * the meeting history.
 */

import { handleJoinPost } from "../src/app-routes.ts";

export async function POST(request: Request): Promise<Response> {
  return handleJoinPost(request);
}
