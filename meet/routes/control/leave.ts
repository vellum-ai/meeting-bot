/**
 * `POST /control/leave` on the vellum ingress listener: have an in-house
 * meet bot leave its meeting. Called by the leave skill script; authenticated
 * with the control token from `data/vellum-control.json`. Thin wrapper over
 * the handler in `src/vellum-meet.ts`.
 */

import { handleVellumLeave } from "../../../src/vellum-meet.ts";

export async function POST(request: Request): Promise<Response> {
  return handleVellumLeave(request);
}
