/**
 * PATH augmentation for spawned runtimes.
 *
 * The daemon's own process env can carry a stripped-down PATH (the
 * assistant's interactive shell builds its PATH from a login profile the
 * daemon never sources), so processes it spawns inherit a PATH missing
 * directories like /data/system/bin, where the assistant image installs
 * its system tools (chromium, Xvfb, pulseaudio, ...). `which chromium`
 * then works from the user's shell but fails inside the vellum worker and
 * every bot process it spawns.
 *
 * The fix is applied twice, belt and braces: the supervisor hands the
 * worker an augmented PATH at spawn, and the worker re-augments its own
 * `process.env.PATH` at boot (covering any other spawn route). Downstream
 * inheritance is then automatic: the browser-stack probes use the
 * process env, and the direct bot runner copies the worker's env into the
 * bot's.
 *
 * Only directories that actually exist are appended, and existing PATH
 * entries always keep priority.
 */

import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Directories that commonly hold the binaries the runtime needs but are
 * absent from a non-login-shell PATH. `/data/system/bin` is where the
 * Vellum assistant image installs its system tooling.
 */
const WELL_KNOWN_BIN_DIRS = [
  "/data/system/bin",
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;

/**
 * Return `current` with any missing well-known bin directories that exist
 * on disk appended (never prepended: whatever the operator put first stays
 * first). `candidates` is injectable for tests.
 */
export function augmentedPath(
  current: string | undefined,
  candidates: readonly string[] = WELL_KNOWN_BIN_DIRS,
): string {
  const parts = (current ?? "").split(delimiter).filter((p) => p.length > 0);
  const present = new Set(parts);
  for (const dir of candidates) {
    if (!present.has(dir) && existsSync(dir)) {
      parts.push(dir);
      present.add(dir);
    }
  }
  return parts.join(delimiter);
}

/**
 * Root of the assistant's relocated apt install (the kata sandbox installs
 * system packages under this prefix instead of /). Matches the assistant's
 * own `VELLUM_APT_DATA_ROOT` convention.
 */
function aptDataRoot(): string {
  const fromEnv = process.env.VELLUM_APT_DATA_ROOT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "/data/system";
}

/** Multiarch triplets we probe under the relocated root. */
const LIB_ARCHES = ["x86_64-linux-gnu", "aarch64-linux-gnu"] as const;

/**
 * Shared-library directories under the relocated apt root, mirroring the
 * assistant's own shell env (usr/lib/<arch>, usr/lib, usr/local/lib) plus
 * two pulseaudio-private dirs whose contents are normally found via baked
 * RUNPATHs that point at the non-relocated /usr tree and therefore break
 * under the apt root: `usr/lib/<arch>/pulseaudio/` (libpulsecore) and the
 * dlopen module dir itself (`pulse-<version>/modules/`), which also holds
 * the modules' shared support libraries such as libprotocol-native.so.
 * Only directories that exist are returned.
 */
export function libraryCandidates(root: string = aptDataRoot()): string[] {
  const dirs: string[] = [];
  for (const arch of LIB_ARCHES) dirs.push(join(root, "usr/lib", arch));
  dirs.push(join(root, "usr/lib"), join(root, "usr/local/lib"));
  for (const arch of LIB_ARCHES) dirs.push(join(root, "usr/lib", arch, "pulseaudio"));
  const modules = pulseModuleDir(root);
  if (modules) dirs.push(modules);
  return dirs.filter((d) => existsSync(d));
}

/**
 * Locate pulseaudio's dlopen module directory under the relocated root
 * (`usr/lib[/<arch>]/pulse-<version>/modules`). The daemon's compile-time
 * module path points at the non-relocated /usr tree, so the bot passes
 * this via `pulseaudio --dl-search-path` (see media/pulse-setup.sh).
 */
export function pulseModuleDir(root: string = aptDataRoot()): string | null {
  const parents = [
    ...LIB_ARCHES.map((arch) => join(root, "usr/lib", arch)),
    join(root, "usr/lib"),
  ];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("pulse-")) continue;
      const modules = join(parent, name, "modules");
      if (existsSync(modules)) return modules;
    }
  }
  return null;
}

/**
 * Return `current` with any missing library candidates PREPENDED (unlike
 * PATH, relocated libraries must win over same-named system libraries so a
 * relocated binary never mislinks against an older system copy; this
 * mirrors the assistant's own env script, which prepends too).
 */
export function prependedLibraryPath(
  current: string | undefined,
  candidates: readonly string[] = libraryCandidates(),
): string {
  const existing = (current ?? "").split(delimiter).filter((p) => p.length > 0);
  const present = new Set(existing);
  const front = candidates.filter((d) => !present.has(d));
  return [...front, ...existing].join(delimiter);
}

/** What {@link augmentProcessEnv} changed, for logging. */
export interface AugmentedEnv {
  addedPathDirs: string[];
  addedLibDirs: string[];
  pulseModuleDir: string | null;
}

/**
 * Augment this process's env in place: PATH (well-known bin dirs appended),
 * LD_LIBRARY_PATH (relocated lib dirs prepended), and PULSE_DL_SEARCH_PATH
 * (pulseaudio's relocated module dir, consumed by the bot's
 * pulse-setup.sh). Returns what changed so callers can log it.
 */
export function augmentProcessEnv(): AugmentedEnv {
  const result: AugmentedEnv = {
    addedPathDirs: [],
    addedLibDirs: [],
    pulseModuleDir: null,
  };

  const pathBefore = process.env.PATH ?? "";
  const pathAfter = augmentedPath(pathBefore);
  if (pathAfter !== pathBefore) {
    const beforeSet = new Set(pathBefore.split(delimiter));
    process.env.PATH = pathAfter;
    result.addedPathDirs = pathAfter
      .split(delimiter)
      .filter((p) => !beforeSet.has(p));
  }

  const libBefore = process.env.LD_LIBRARY_PATH ?? "";
  const libAfter = prependedLibraryPath(libBefore);
  if (libAfter !== libBefore) {
    const beforeSet = new Set(libBefore.split(delimiter));
    process.env.LD_LIBRARY_PATH = libAfter;
    result.addedLibDirs = libAfter
      .split(delimiter)
      .filter((p) => !beforeSet.has(p));
  }

  const modules = pulseModuleDir();
  if (modules && !process.env.PULSE_DL_SEARCH_PATH) {
    process.env.PULSE_DL_SEARCH_PATH = modules;
    result.pulseModuleDir = modules;
  }

  return result;
}

/**
 * A copy of `base` with the same augmentations applied, for handing to a
 * spawned child without mutating this process (the supervisor uses this
 * when spawning the worker).
 */
export function augmentedSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const modules = pulseModuleDir();
  return {
    ...base,
    PATH: augmentedPath(base.PATH),
    LD_LIBRARY_PATH: prependedLibraryPath(base.LD_LIBRARY_PATH),
    ...(modules && !base.PULSE_DL_SEARCH_PATH
      ? { PULSE_DL_SEARCH_PATH: modules }
      : {}),
  };
}
