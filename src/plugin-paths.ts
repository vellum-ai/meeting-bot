/**
 * Filesystem locations inside the installed plugin.
 *
 * This module lives at `<plugin-root>/src/`, so the plugin's writable data
 * directory is a sibling: `<plugin-root>/data/`. That directory is where the
 * `init` hook writes `resolved-config.json`, the join skill writes
 * `sessions.json`, and the app settings are stored. It is preserved across
 * `--force` reinstalls (see CONTRIBUTING.md).
 *
 * Resolving from this module's own location (rather than a caller's) keeps the
 * answer stable no matter which surface asks: hooks, routes, or scripts.
 */

import { join } from "node:path";

/** Absolute path to `<plugin-root>/`. */
function pluginRootDir(): string {
  // `new URL(".", import.meta.url).pathname` is this file's directory
  // (`<plugin-root>/src/`, trailing slash); its parent is the plugin root.
  return join(new URL(".", import.meta.url).pathname, "..");
}

/** Absolute path to `<plugin-root>/data/`. */
export function pluginDataDir(): string {
  return join(pluginRootDir(), "data");
}

/**
 * Absolute path to `<plugin-root>/config.json`, the host-owned plugin config
 * the configuration app edits (see CONTRIBUTING.md; preserved across `--force`
 * reinstalls).
 */
export function pluginConfigPath(): string {
  return join(pluginRootDir(), "config.json");
}
