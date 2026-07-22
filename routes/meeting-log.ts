/**
 * `GET /x/plugins/meeting-bot/meeting-log?botId=...`: captured bot log for
 * one meeting.
 */

import { handleMeetingLogGet } from "../src/app-routes.ts";

export async function GET(request: Request): Promise<Response> {
  return handleMeetingLogGet(request);
}
