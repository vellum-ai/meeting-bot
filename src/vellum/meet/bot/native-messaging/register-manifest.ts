/**
 * Direct-mode registration of the Chrome native-messaging host manifest.
 *
 * Inside the bot container the Dockerfile renders the NMH manifest to a
 * system search path (/etc/chromium/native-messaging-hosts) at image-build
 * time. In direct mode nothing does that, so the extension's
 * `chrome.runtime.connectNative("com.vellum.meet")` finds no host, the
 * ready handshake never happens, and the bot times out waiting.
 *
 * Chromium also searches `<user-data-dir>/NativeMessagingHosts`, which the
 * bot owns and can always write. When no system manifest is present this
 * module renders one there, with two direct-mode adjustments:
 *
 *   - the host `path` points at this tree's `nmh-shim.ts` (the template
 *     carries the container path `/app/bot/...`), and
 *   - the shim's executable bit is ensured, since a plugin install does
 *     not necessarily preserve it the way the Dockerfile's chmod does.
 */

import { chmodSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  computeExtensionId,
  renderManifest,
} from "../scripts/render-nmh-manifest.js";

/** System locations the container image renders the manifest into. */
const SYSTEM_NMH_MANIFESTS = [
  "/etc/chromium/native-messaging-hosts/com.vellum.meet.json",
  "/etc/opt/chrome/native-messaging-hosts/com.vellum.meet.json",
] as const;

/**
 * Ensure Chromium can resolve the `com.vellum.meet` native host for this
 * meeting's profile. No-op when a system manifest exists (the container
 * case). Throws with an actionable message when the extension dist is
 * missing, since the manifest render needs the extension's public key and
 * Chrome could not load the extension anyway.
 */
export async function ensureNmhManifestRegistered(opts: {
  /** The per-meeting Chrome user-data directory. */
  userDataDir: string;
  /** The built extension directory Chrome loads (contains manifest.json). */
  extensionPath: string;
  logInfo: (message: string) => void;
}): Promise<void> {
  if (SYSTEM_NMH_MANIFESTS.some((path) => existsSync(path))) {
    return;
  }

  const extManifestPath = join(opts.extensionPath, "manifest.json");
  if (!existsSync(extManifestPath)) {
    throw new Error(
      `Meet controller extension not found at ${opts.extensionPath} (no manifest.json); ` +
        "the extension dist was not built or EXTENSION_PATH points somewhere wrong",
    );
  }

  const extManifest = JSON.parse(await readFile(extManifestPath, "utf8")) as {
    key?: string;
  };
  if (!extManifest.key) {
    throw new Error(
      `extension manifest at ${extManifestPath} carries no "key"; cannot derive the extension id for the NMH manifest`,
    );
  }
  const extId = computeExtensionId(extManifest.key);

  const templatePath = resolve(import.meta.dir, "com.vellum.meet.json");
  const shimPath = resolve(import.meta.dir, "nmh-shim.ts");
  const manifest = JSON.parse(
    renderManifest(await readFile(templatePath, "utf8"), extId),
  ) as Record<string, unknown>;
  // The template's host path is the container location; direct mode runs
  // the shim from the plugin tree.
  manifest.path = shimPath;

  try {
    chmodSync(shimPath, 0o755);
  } catch {
    // Best-effort: if the tree is read-only the bit is either already set
    // (repo mode preserved it) or the connect fails with a clear exec
    // error in Chrome's log.
  }

  const outDir = join(opts.userDataDir, "NativeMessagingHosts");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "com.vellum.meet.json");
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  opts.logInfo(
    `nmh: registered native-messaging host manifest at ${outPath} (extension ${extId}, shim ${shimPath})`,
  );
}
