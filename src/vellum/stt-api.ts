/**
 * Feature-detected access to the host's `openTranscriptionSession` API.
 *
 * vellum-assistant PR #38722 added `openTranscriptionSession()` to the
 * plugin-api surface (shipping in `@vellumai/plugin-api` 0.10.12): it opens
 * a streaming STT session against the assistant's configured provider
 * (`services.stt.provider`). The plugin's installed 0.10.10 typings do not
 * declare it yet, so this module probes the runtime export and degrades to
 * `null` on hosts that predate it, exactly matching the API's own "no
 * session available" contract. When the dependency moves to 0.10.12, this
 * shim reduces to a plain re-export.
 *
 * Daemon-side only: like `resolveCredential`, the API works in the process
 * the plugin's hooks run in, not in spawned children. The Vellum Runtime
 * worker reaches it through the stdio relay (see `stt-bridge.ts` and
 * `stt-relay.ts`).
 */

import * as pluginApi from "@vellumai/plugin-api";

import type { StreamingTranscriber } from "./stt-types.ts";

type MaybeSttApi = {
  openTranscriptionSession?: () => Promise<StreamingTranscriber | null>;
};

/** True when the running host exposes `openTranscriptionSession`. */
export function hostSupportsTranscription(): boolean {
  return (
    typeof (pluginApi as unknown as MaybeSttApi).openTranscriptionSession ===
    "function"
  );
}

/**
 * Open a streaming transcription session, or resolve `null` when the host
 * cannot provide one (API not present on this host version, no configured
 * provider, no streaming adapter, or missing credentials).
 */
export async function openTranscriptionSession(): Promise<StreamingTranscriber | null> {
  const api = pluginApi as unknown as MaybeSttApi;
  if (typeof api.openTranscriptionSession !== "function") return null;
  return api.openTranscriptionSession();
}
