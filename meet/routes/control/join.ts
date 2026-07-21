/**
 * `POST /control/join` on the vellum ingress listener: join a meeting via
 * the in-house meet bot. Called by the join skill script; authenticated with
 * the control token from `data/vellum-control.json`. Thin wrapper over the
 * handler in `src/vellum-meet.ts`, which owns validation, the session-manager
 * call, and session-store bookkeeping.
 */

import { handleVellumJoin } from "../../../src/vellum-meet.ts";

export async function POST(request: Request): Promise<Response> {
  return handleVellumJoin(request);
}
