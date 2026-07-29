/**
 * `POST /x/plugins/meeting-bot/realtime`: one realtime meeting event,
 * delivered by the gateway from the public ingress socket this plugin
 * declares in `channels/ingress.json`.
 */

import { handleRealtimePost } from "../src/app-routes.ts";

export async function POST(request: Request): Promise<Response> {
  return handleRealtimePost(request);
}
