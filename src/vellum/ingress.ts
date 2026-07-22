/**
 * In-process HTTP ingress for meet-bot events.
 *
 * Replaces the vendored two-process pair (`meet/src/ingress-listener.ts`
 * spawning `meet/src/ingress-server.ts` and relaying requests over a
 * JSON-lines stdio protocol). That split existed in meet-join to keep the
 * TCP-facing server out of the daemon's process; in meeting-bot the whole
 * Vellum Runtime already runs in its own worker process, so the ingress can
 * bind and dispatch in-process and the worker stays a single process in
 * `assistant ps`.
 *
 * ## Route resolution
 *
 * Routes follow the assistant's file-based convention: a request for
 * `/<path>` maps to `<routesDir>/<path>.ts` (or `.js`), falling back to
 * `<routesDir>/<path>/index.ts`. Each route module exports named functions
 * per HTTP method (`export async function POST(...)`) with the standard Web
 * API Request/Response signature. Missing file = 404; file present but
 * method not exported = 405 with an `Allow` header. Test files
 * (`__tests__/`, `*.test.ts`, `*.d.ts`) are never served.
 *
 * ## Reachability
 *
 * Binds `0.0.0.0` on an ephemeral port. The bot reaches it at:
 *
 * - direct backend: `127.0.0.1:<port>` (the bot is a child process on the
 *   same host, loopback always works).
 * - docker backend: `host.docker.internal:<port>` (the bot container
 *   resolves that to the machine running the worker). This works when the
 *   assistant runs bare-metal; when the assistant itself runs in a
 *   container the ephemeral port is not published to the host, a known
 *   limitation until the assistant's `routes/` auto-registration lands.
 *
 * Every request is authenticated by the route handler itself (per-meeting
 * bearer tokens minted at join time), so binding beyond loopback does not
 * widen exposure.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Logger } from "./meet/plugin-host.ts";

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

export interface MeetIngress {
  /** Port the server bound (ephemeral, chosen by the OS). */
  readonly port: number;
  /** Base URL the bot should use as `DAEMON_URL` for the given backend. */
  urlForBackend(backend: "docker" | "direct"): string;
  /** Stop the server, draining in-flight requests. */
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
 * Resolve a route path to a route module on disk, mirroring the assistant's
 * dispatcher: direct file match first, then index fallback.
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

/**
 * Start the ingress server on `0.0.0.0:<ephemeral>`, dispatching requests to
 * the route modules under `routesDir`.
 */
export function startMeetIngress(log: Logger, routesDir: string): MeetIngress {
  const moduleCache = new Map<string, Partial<Record<HttpMethod, RouteHandler>>>();

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const routePath = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
      if (
        routePath.length === 0 ||
        routePath.includes("..") ||
        isNonRouteFile(routePath)
      ) {
        return new Response("not found", { status: 404 });
      }

      const filePath = resolveRouteFile(routesDir, routePath);
      if (!filePath) {
        return new Response("not found", { status: 404 });
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
        log.error("meeting-bot: failed to load ingress route module", {
          routePath,
          error: err instanceof Error ? err.message : String(err),
        });
        return new Response("internal error", { status: 500 });
      }

      const handler = handlers[req.method as HttpMethod];
      if (!handler) {
        const allowed = HTTP_METHODS.filter((m) => m in handlers);
        return new Response("method not allowed", {
          status: 405,
          headers: { Allow: allowed.join(", ") },
        });
      }

      try {
        return await handler(req);
      } catch (err) {
        log.error("meeting-bot: ingress route handler error", {
          routePath,
          error: err instanceof Error ? err.message : String(err),
        });
        return new Response("internal error", { status: 500 });
      }
    },
  });

  const port = server.port;
  log.info("meeting-bot: ingress started", { port });

  return {
    port,
    urlForBackend(backend: "docker" | "direct"): string {
      const host = backend === "docker" ? "host.docker.internal" : "127.0.0.1";
      return `http://${host}:${port}`;
    },
    async stop(): Promise<void> {
      await server.stop(true);
      log.info("meeting-bot: ingress stopped", { port });
    },
  };
}
