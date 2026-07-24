/**
 * Compat symlinks for compile-time absolute paths under a relocated apt root.
 *
 * Some binaries in the relocated root resolve helper files at absolute
 * paths baked in at compile time, with no runtime override: Xvfb execs
 * `/usr/bin/xkbcomp` to compile its keymap ("XKB: Failed to compile
 * keymap" then a fatal keyboard-init error when it is missing) and reads
 * XKB data from `/usr/share/X11/xkb`; Debian's chromium wrapper sources
 * `/etc/chromium.d/*`. PATH and LD_LIBRARY_PATH augmentation cannot reach
 * these, so the worker bridges them with symlinks into the relocated root
 * at boot.
 *
 * Best-effort by design: each link is only attempted when the system path
 * is absent and the relocated equivalent exists, and a failure (for
 * example a read-only root filesystem) is reported, not thrown, so the
 * runtime still comes up and the log states exactly which bridge is
 * missing.
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Paths (relative to both `/` and the relocated root) that relocated
 * binaries resolve at compile-time absolute locations.
 */
const COMPAT_LINK_PATHS = [
  // Xvfb execs this to compile its keymap; hardcoded, no env/flag override.
  "usr/bin/xkbcomp",
  // XKB keymap data read by the xkbcomp invocation above.
  "usr/share/X11/xkb",
  // Debian's chromium wrapper sources this dir. The launcher prefers the
  // real ELF and does not need it, but other chromium entry points do.
  "etc/chromium.d",
] as const;

function aptDataRoot(): string {
  const fromEnv = process.env.VELLUM_APT_DATA_ROOT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "/data/system";
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface CompatLinkReport {
  /** Links created this run, as `link -> target`. */
  created: string[];
  /** Links that could not be created, with the failure reason. */
  failed: Array<{ link: string; error: string }>;
}

/**
 * Create the missing compat symlinks. `systemPrefix` is the filesystem
 * root the links are created under (injectable for tests); `root` is the
 * relocated apt root the links point into.
 */
export function ensureRelocatedCompatLinks(
  opts: { root?: string; systemPrefix?: string } = {},
): CompatLinkReport {
  const root = opts.root ?? aptDataRoot();
  const systemPrefix = opts.systemPrefix ?? "/";
  const report: CompatLinkReport = { created: [], failed: [] };

  for (const rel of COMPAT_LINK_PATHS) {
    const link = join(systemPrefix, rel);
    const target = join(root, rel);
    // Anything already at the system path wins: a real install, a link
    // from a previous boot (including a broken one, which lstat still
    // reports), or an operator-provided override.
    if (entryExists(link)) continue;
    if (!existsSync(target)) continue;
    try {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
      report.created.push(`${link} -> ${target}`);
    } catch (err) {
      report.failed.push({ link, error: String(err).slice(0, 200) });
    }
  }

  return report;
}
