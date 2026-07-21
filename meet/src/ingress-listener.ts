/**
 * Plugin-owned HTTP listener for meet-bot ingress, run as a subprocess.
 *
 * The HTTP server (the thing that binds `0.0.0.0` on an ephemeral TCP port
 * and accepts connections from the bot) lives in a separate OS process,
 * spawned here and terminated during shutdown. This keeps it out of the
 * daemon's process tree and event loop. The subprocess relays each HTTP
 * request to this (daemon-side) module via a JSON-lines protocol over
 * stdio; the daemon side handles file-based routing and route-handler
 * dispatch, where the live `SkillHost` and session event router are
 * accessible.
 *
 * ## Route resolution
 *
 * Routes follow the assistant's file-based convention: the file path under
 * the top-level `routes/` directory is the route path, and each route module
 * exports named functions per HTTP method (`export async function POST(...)`)
 * with the standard Web API Request/Response signature. The assistant will
 * soon discover `routes/` and auto-register these handlers on its own
 * server; until that lands, this listener serves the same files with the
 * same resolution semantics, so the route modules are already in their
 * final shape and only the transport moves.
 *
 * Resolution mirrors the assistant's dispatcher: a request for `/<path>`
 * maps to `routes/<path>.ts` (or `.js`), falling back to
 * `routes/<path>/index.ts`. Missing file = 404; file present but method not
 * exported = 405 with an `Allow` header. Test files (`__tests__/`,
 * `*.test.ts`, `*.d.ts`) are never served.
 *
 * ## Reachability
 *
 * The subprocess binds `0.0.0.0` on an ephemeral port. The bot reaches it at:
 *
 * - **direct backend** — `127.0.0.1:<port>`; the bot is a child process on
 *   the same host, loopback always works.
 * - **docker backend** — `host.docker.internal:<port>`; the bot container
 *   resolves that to the machine running the assistant process. This works
 *   when the assistant runs bare-metal. When the assistant itself runs in a
 *   container, the ephemeral port is not published to the host, so docker
 *   bots cannot reach it — a known limitation until the assistant's
 *   `routes/` auto-registration lands and the route moves onto the
 *   daemon's own server.
 *
 * Every request is authenticated by the route handler itself (per-meeting
 * bearer tokens minted at join time), matching the exposure the daemon
 * route had.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "../plugin-host.js";

/** HTTP methods a route module may export handlers for. */
const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

/** Signature route modules must export per HTTP method. */
type RouteHandler = (request: Request) => Response | Promise<Response>;

/** Supported file extensions for route modules. */
const ROUTE_EXTENSIONS = [".ts", ".js"] as const;

/** Default location of the plugin's route modules: `<repo>/routes/`. */
const DEFAULT_ROUTES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "routes",
);

/** Path to the subprocess entry point. */
const INGRESS_SERVER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "ingress-server.ts",
);

/** Time to wait for the subprocess to report READY before giving up. */
const READY_TIMEOUT_MS = 10_000;

export interface MeetIngressListener {
  /** Port the subprocess bound (ephemeral, chosen by the OS). */
  readonly port: number;
  /** Base URL the bot should use as `DAEMON_URL` for the given backend. */
  urlForBackend(backend: "docker" | "direct"): string;
  /** Stop the subprocess and clean up. */
  stop(): Promise<void>;
}

/** True when the path points at test scaffolding rather than a route module. */
function isNonRouteFile(routePath: string): boolean {
  return (
    routePath.split("/").includes("__tests__") ||
    routePath.endsWith(".test") ||
    routePath.endsWith(".d")
  );
}

/**
 * Resolve a route path to a route module on disk, mirroring the
 * assistant's dispatcher: direct file match first, then index fallback.
 */
function resolveRouteFile(routesDir: string, routePath: string): string | null {
  const resolved = resolve(join(routesDir, routePath));
  // Belt-and-braces traversal guard on top of the `..` request check.
  if (!resolved.startsWith(resolve(routesDir))) return null;

  for (const ext of ROUTE_EXTENSIONS) {
    const candidate = `${resolved}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const ext of ROUTE_EXTENSIONS) {
    const candidate = join(resolved, `index${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** IPC request from the subprocess. */
interface IpcRequest {
  id: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** IPC response to the subprocess. */
interface IpcResponse {
  id: number;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Handle a single IPC request: resolve the route file, import the handler,
 * execute it, and return the HTTP response as an IPC response.
 */
async function handleIpcRequest(
  ipcReq: IpcRequest,
  routesDir: string,
  moduleCache: Map<string, Partial<Record<HttpMethod, RouteHandler>>>,
  log: Logger,
): Promise<IpcResponse> {
  const url = new URL(ipcReq.url);
  const routePath = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const notFound: IpcResponse = {
    id: ipcReq.id,
    status: 404,
    headers: {},
    body: "not found",
  };

  if (routePath.length === 0 || routePath.includes("..")) {
    return notFound;
  }
  if (isNonRouteFile(routePath)) {
    return notFound;
  }

  const filePath = resolveRouteFile(routesDir, routePath);
  if (!filePath) {
    return notFound;
  }

  let handlers: Partial<Record<HttpMethod, RouteHandler>>;
  try {
    const cached = moduleCache.get(filePath);
    if (cached) {
      handlers = cached;
    } else {
      const mod = (await import(filePath)) as Record<string, unknown>;
      handlers = {};
      for (const method of HTTP_METHODS) {
        if (typeof mod[method] === "function") {
          handlers[method] = mod[method] as RouteHandler;
        }
      }
      moduleCache.set(filePath, handlers);
    }
  } catch (err) {
    log.error("meet-join: failed to load route module", {
      routePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...notFound, status: 500, body: "internal error" };
  }

  const handler = handlers[ipcReq.method as HttpMethod];
  if (!handler) {
    const allowed = HTTP_METHODS.filter((m) => m in handlers);
    return {
      ...notFound,
      status: 405,
      headers: { Allow: allowed.join(", ") },
      body: "method not allowed",
    };
  }

  // Reconstruct a Request from the IPC payload so the route handler
  // sees a standard Web API request.
  const headers = new Headers();
  for (const [key, value] of Object.entries(ipcReq.headers)) {
    headers.set(key, value);
  }
  const req = new Request(ipcReq.url, {
    method: ipcReq.method,
    headers,
    body: ipcReq.body,
  });

  const resp = await handler(req);
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    respHeaders[key] = value;
  });
  const respBody = resp.body ? await resp.text() : null;

  return {
    id: ipcReq.id,
    status: resp.status,
    headers: respHeaders,
    body: respBody,
  };
}

/**
 * Spawn the ingress subprocess, wait for it to report READY, and return a
 * handle for stopping it later. Async because the READY signal arrives
 * asynchronously via the subprocess's stdout.
 *
 * Uses a single stdout reader for both the READY phase and the subsequent
 * request-dispatch phase to avoid ReadableStream lock conflicts.
 */
export async function startMeetIngressListener(
  log: Logger,
  routesDir: string = DEFAULT_ROUTES_DIR,
): Promise<MeetIngressListener> {
  const moduleCache = new Map<
    string,
    Partial<Record<HttpMethod, RouteHandler>>
  >();

  // Spawn the subprocess HTTP server.
  const child = Bun.spawn({
    cmd: [process.execPath, INGRESS_SERVER_PATH],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  // Single reader for all stdout from the subprocess. The first line is
  // `READY <port>`; subsequent lines are JSON IPC requests. Using one
  // reader avoids ReadableStream lock conflicts.
  const decoder = new TextDecoder();
  let stdoutBuffer = "";
  let readyResolve: ((port: number) => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let childPort = 0;

  const readyPromise = new Promise<number>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  const reader = child.stdout.getReader();
  const readLoop = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdoutBuffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (line.length === 0) continue;

        if (readyResolve && line.startsWith("READY ")) {
          childPort = parseInt(line.slice(6), 10);
          const r = readyResolve as (port: number) => void;
          readyResolve = null;
          readyReject = null;
          r(childPort);
          continue;
        }

        // Parse as IPC request (only after READY).
        if (childPort > 0) {
          try {
            const ipcReq = JSON.parse(line) as IpcRequest;
            handleIpcRequest(ipcReq, routesDir, moduleCache, log)
              .then((ipcResp: IpcResponse) => {
                child.stdin.write(JSON.stringify(ipcResp) + "\n");
                child.stdin.flush();
              })
              .catch((err) => {
                log.error("meet-join: ingress handler error", {
                  error: err instanceof Error ? err.message : String(err),
                });
                const errorResp: IpcResponse = {
                  id: ipcReq.id,
                  status: 500,
                  headers: {},
                  body: "internal error",
                };
                child.stdin.write(JSON.stringify(errorResp) + "\n");
                child.stdin.flush();
              });
          } catch {
            // Malformed line — ignore.
          }
        }
      }
    }
    // stdout closed before READY.
    if (readyReject) {
      const r = readyReject as (err: Error) => void;
      readyResolve = null;
      readyReject = null;
      r(new Error("ingress subprocess closed stdout before READY"));
    }
  })();
  readLoop.catch((err) => {
    if (readyReject) {
      const r = readyReject;
      readyResolve = null;
      readyReject = null;
      r(
        err instanceof Error
          ? err
          : new Error("ingress stdout read loop failed"),
      );
    } else {
      log.error("meet-join: ingress stdout read loop failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Wait for READY with a timeout.
  childPort = await Promise.race([
    readyPromise,
    new Promise<number>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `ingress subprocess did not report READY within ${READY_TIMEOUT_MS}ms`,
            ),
          ),
        READY_TIMEOUT_MS,
      ),
    ),
  ]);

  log.info("meet-join: ingress listener started", { port: childPort });

  return {
    port: childPort,
    urlForBackend(backend: "docker" | "direct"): string {
      const host = backend === "docker" ? "host.docker.internal" : "127.0.0.1";
      return `http://${host}:${childPort}`;
    },
    async stop(): Promise<void> {
      child.kill("SIGTERM");
      // Wait for the subprocess to exit (with a timeout).
      const exitPromise = child.exited;
      const timeout = new Promise<void>((r) => setTimeout(() => r(), 5000));
      await Promise.race([exitPromise, timeout]);
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      log.info("meet-join: ingress listener stopped", { port: childPort });
    },
  };
}
