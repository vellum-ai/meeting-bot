/**
 * Subprocess entry point for the meet-bot ingress listener.
 *
 * Spawned by `src/ingress-listener.ts` as a separate OS process. Binds
 * `0.0.0.0` on an ephemeral TCP port (the URL the bot POSTs events to) and
 * relays each request to the parent process via a JSON-lines protocol over
 * stdio. The parent handles file-based routing and route-handler dispatch
 * (where `getMeetHost()` and the session event router live); this process
 * is purely the TCP-facing HTTP server.
 *
 * ## IPC protocol (JSON lines over stdio)
 *
 * 1. On startup this process writes `READY <port>\n` to stdout.
 * 2. For each HTTP request it writes a JSON line to stdout:
 *    `{"id":<n>,"method":"POST","url":"http://...","headers":{...},"body":"..."}`
 * 3. The parent writes a JSON line to stdin:
 *    `{"id":<n>,"status":204,"headers":{},"body":null}`
 * 4. This process writes the HTTP response and closes the request.
 *
 * Requests are processed concurrently by the HTTP server but serialized
 * through the stdio pipe — the meet bot sends batched events in a single
 * POST, so concurrency is not a concern.
 *
 * ## Graceful shutdown
 *
 * The parent sends `SIGTERM` to stop the subprocess. The Bun.serve
 * `stop()` call drains in-flight connections.
 */

const PORT = 0; // ephemeral

interface PendingRequest {
  resolve: (response: {
    status: number;
    headers: Record<string, string>;
    body: string | null;
  }) => void;
}

let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

// Read response lines from stdin (parent → child).
const decoder = new TextDecoder();
let stdinBuffer = "";

async function readStdin(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    stdinBuffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = stdinBuffer.indexOf("\n")) >= 0) {
      const line = stdinBuffer.slice(0, newlineIdx);
      stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
      if (line.trim().length === 0) continue;
      try {
        const resp = JSON.parse(line) as {
          id: number;
          status: number;
          headers?: Record<string, string>;
          body?: string | null;
        };
        const pending_req = pending.get(resp.id);
        if (pending_req) {
          pending.delete(resp.id);
          pending_req.resolve({
            status: resp.status,
            headers: resp.headers ?? {},
            body: resp.body ?? null,
          });
        }
      } catch {
        // Malformed line — ignore.
      }
    }
  }
}

// Start reading stdin responses.
readStdin().catch(() => {
  // stdin closed — parent is shutting down.
  process.exit(0);
});

function sendRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<{ status: number; headers: Record<string, string>; body: string | null }> {
  const id = nextRequestId++;
  const promise = new Promise<{
    status: number;
    headers: Record<string, string>;
    body: string | null;
  }>((resolve) => {
    pending.set(id, { resolve });
  });
  const payload = JSON.stringify({ id, method, url, headers, body });
  Bun.write(Bun.stdout, payload + "\n");
  return promise;
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  fetch: async (req: Request): Promise<Response> => {
    let body: string | null = null;
    if (req.body) {
      body = await req.text();
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });

    try {
      const resp = await sendRequest(req.method, req.url, headers, body);
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(resp.headers)) {
        responseHeaders.set(key, value);
      }
      return new Response(resp.body, {
        status: resp.status,
        headers: responseHeaders,
      });
    } catch {
      return new Response("ingress proxy error", { status: 502 });
    }
  },
});

// Signal readiness to the parent.
console.log(`READY ${server.port}`);

// Handle SIGTERM from parent for graceful shutdown.
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
