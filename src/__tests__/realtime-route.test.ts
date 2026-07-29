/**
 * The plugin route the gateway posts gateway-terminated realtime frames to.
 *
 * Frames arrive one at a time as the raw request body, so these cover what
 * the handler does with a body it did not choose the shape of.
 */

import { describe, expect, test } from "bun:test";

import { handleRealtimePost } from "../app-routes.ts";
import { resolveConfig } from "../config.ts";
import {
  clearResolvedConfigForTests,
  setResolvedConfig,
} from "../plugin-state.ts";

function initialize(): void {
  setResolvedConfig(resolveConfig({}).config);
}

function post(body: string): Request {
  return new Request("http://localhost/x/plugins/meeting-bot/realtime", {
    method: "POST",
    body,
  });
}

describe("handleRealtimePost", () => {
  test("refuses frames before the plugin has initialized", async () => {
    // Dispatch needs the resolved config; answering 503 tells the gateway
    // this is transient rather than a malformed frame.
    clearResolvedConfigForTests();

    const res = await handleRealtimePost(post('{"event":"transcript.data"}'));

    expect(res.status).toBe(503);
  });

  test("drops a non-JSON frame without failing the delivery", async () => {
    // The sender is an event stream, not a client that can correct itself,
    // so a bad frame is dropped rather than answered with an error the
    // gateway would only log.
    initialize();

    expect((await handleRealtimePost(post("not json at all"))).status).toBe(
      204,
    );
  });

  test("drops a JSON frame carrying no event name", async () => {
    initialize();

    expect((await handleRealtimePost(post('{"data":{}}'))).status).toBe(204);
  });

  test("accepts a well-formed frame", async () => {
    initialize();

    const res = await handleRealtimePost(
      post(JSON.stringify({ event: "transcript.data", data: {} })),
    );

    expect(res.status).toBe(204);
  });
});
