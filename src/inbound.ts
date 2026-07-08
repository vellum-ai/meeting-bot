/**
 * Inbound connectivity — expose the local realtime WebSocket server to the
 * public internet so Recall.ai can dial back in.
 *
 * Recall's realtime model is inbound: when a bot is created, Recall opens a
 * WebSocket connection FROM its infrastructure TO a public URL the plugin
 * provides. That means the plugin's realtime server (bound on a local port)
 * must be reachable from the outside world.
 *
 * ## Current approach (temporary)
 *
 * Today we spawn a Cloudflare Tunnel (`cloudflared tunnel --url`) as a child
 * process to bridge the local listener to a public `wss://` URL. This works
 * but has serious limitations:
 *
 *   - The tunnel URL is ephemeral (changes on every restart).
 *   - There is no authentication on the tunnel path.
 *   - We are shelling out to an external binary that may not be installed.
 *   - The tunnel process is another moving part to supervise.
 *
 * SECURITY WARNING: This approach is insecure. The tunnel exposes the
 * realtime WebSocket server to the public internet without authentication
 * (unless a verification token is configured). Anyone who discovers the URL
 * can connect and inject fake transcript events. The Vellum team is looking
 * into a way to define inbound config for long-term support — a platform-level
 * mechanism for plugins to declare inbound endpoints with proper auth, stable
 * URLs, and lifecycle management. Until that exists, this manual tunnel is the
 * bridge.
 *
 * ## Future
 *
 * When the platform provides an inbound-endpoint API, `setupInbound` will
 * request a stable, authenticated public URL from the host and return it
 * without spawning any external process. The call site (the init hook) will
 * not need to change.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "./realtime-server.ts";

/** Time to wait for cloudflared to print its tunnel URL. */
const TUNNEL_READY_TIMEOUT_MS = 15_000;

/** Regex to extract the public URL from cloudflared's stderr. */
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Time to wait for cloudflared to exit on shutdown. */
const STOP_GRACE_MS = 5_000;

let tunnelProcess: ChildProcess | null = null;

export interface InboundResult {
  /** The public wss:// URL Recall should connect to. */
  publicWsUrl: string;
}

/**
 * Set up inbound connectivity for the realtime WebSocket server.
 *
 * Spawns a Cloudflare Tunnel pointing at `localhost:listenPort` and waits for
 * it to print the public URL. Returns the URL as `wss://` (upgrading the
 * `https://` cloudflared assigns).
 *
 * If `publicWsUrl` is already set in config, the caller should skip this
 * function entirely — it is only for the auto-tunnel path.
 *
 * Throws if cloudflared is not installed, exits before readiness, or does not
 * print a URL within the timeout.
 */
export function setupInbound(
  listenPort: number,
  logger: Logger,
): Promise<InboundResult> {
  if (tunnelProcess) {
    logger.warn(
      {},
      "meeting-bot: inbound tunnel already running — reusing existing process",
    );
    // We cannot recover the URL from a running process, so reject.
    // The caller should not call setupInbound twice.
    return Promise.reject(
      new Error("inbound tunnel already running — cannot reuse URL"),
    );
  }

  return new Promise<InboundResult>((resolve, reject) => {
    const target = `http://localhost:${listenPort}`;
    logger.info(
      { target },
      "meeting-bot: starting Cloudflare Tunnel for inbound realtime connectivity",
    );

    let child: ChildProcess;
    try {
      child = spawn(
        "cloudflared",
        ["tunnel", "--url", target],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        },
      );
    } catch (err) {
      reject(
        new Error(
          `meeting-bot: failed to spawn cloudflared — is it installed? ${String(err)}`,
        ),
      );
      return;
    }

    tunnelProcess = child;
    let resolved = false;
    const stderrBuffer: string[] = [];

    const readyTimer = setTimeout(() => {
      if (!resolved) {
        logger.error(
          { timeoutMs: TUNNEL_READY_TIMEOUT_MS, stderr: stderrBuffer.join("").slice(0, 500) },
          "meeting-bot: cloudflared did not produce a tunnel URL in time",
        );
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort
        }
        tunnelProcess = null;
        reject(
          new Error(
            `cloudflared did not produce a tunnel URL within ${TUNNEL_READY_TIMEOUT_MS}ms`,
          ),
        );
      }
    }, TUNNEL_READY_TIMEOUT_MS);
    if (typeof readyTimer.unref === "function") readyTimer.unref();

    // cloudflared prints the tunnel URL on stderr.
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer.push(chunk);
      const match = chunk.match(TUNNEL_URL_REGEX);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(readyTimer);
        const httpsUrl = match[0];
        const wssUrl = httpsUrl.replace(/^https:\/\//, "wss://");
        logger.info(
          { publicWsUrl: wssUrl, httpsUrl },
          "meeting-bot: Cloudflare Tunnel is ready",
        );
        resolve({ publicWsUrl: wssUrl });
      }
    });

    // Also capture stdout in case cloudflared prints there in some versions.
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      const match = chunk.match(TUNNEL_URL_REGEX);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(readyTimer);
        const httpsUrl = match[0];
        const wssUrl = httpsUrl.replace(/^https:\/\//, "wss://");
        logger.info(
          { publicWsUrl: wssUrl, httpsUrl },
          "meeting-bot: Cloudflare Tunnel is ready",
        );
        resolve({ publicWsUrl: wssUrl });
      }
    });

    child.on("exit", (code, signal) => {
      clearTimeout(readyTimer);
      if (!resolved) {
        tunnelProcess = null;
        reject(
          new Error(
            `cloudflared exited before producing a tunnel URL (code=${code}, signal=${signal})`,
          ),
        );
      } else {
        logger.info(
          { code, signal },
          "meeting-bot: cloudflared tunnel process exited",
        );
        tunnelProcess = null;
      }
    });

    child.on("error", (err) => {
      clearTimeout(readyTimer);
      tunnelProcess = null;
      if (!resolved) {
        reject(
          new Error(
            `meeting-bot: cloudflared spawn error — is it installed? ${String(err)}`,
          ),
        );
      }
    });
  });
}

/**
 * Tear down the inbound tunnel if one is running. Sends SIGTERM, waits, then
 * SIGKILL. Safe to call when no tunnel is active.
 */
export async function teardownInbound(logger: Logger): Promise<void> {
  if (!tunnelProcess) return;
  const child = tunnelProcess;

  try {
    child.kill("SIGTERM");
  } catch {
    // already dead
  }

  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }

  tunnelProcess = null;
  logger.info({}, "meeting-bot: inbound tunnel stopped");
}
