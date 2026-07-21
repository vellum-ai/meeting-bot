/**
 * The plugin config as the configuration app sees it.
 *
 * The app shows the whole resolved config read-only and lets a few fields be
 * edited (see {@link ConfigUpdateSchema}: voice mode, provider, region). Values
 * live in the host-owned plugin `config.json` (the same file the `init` hook
 * reads via `InitContext.config`); an edit merges into that file so unrelated
 * fields are preserved.
 *
 * The read-only view omits `verificationToken` (a realtime shared secret) so it
 * is never sent to the browser. The editable fields are not consumed to change
 * behavior yet; a later change wires `useVoiceMode` / `provider` (and honors an
 * edited `region`) into the join / voice-response paths.
 */

import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  MEETING_PROVIDERS,
  MeetingBotConfigSchema,
  RECALL_REGIONS,
  type MeetingBotConfig,
} from "./config.ts";

/** The resolved config the app displays: everything except the shared secret. */
export type ConfigView = Omit<MeetingBotConfig, "verificationToken">;

/** Partial update accepted by the settings PATCH route (the editable fields). */
export const ConfigUpdateSchema = z
  .object({
    useVoiceMode: z.boolean().optional(),
    provider: z.enum(MEETING_PROVIDERS).optional(),
    region: z.enum(RECALL_REGIONS).optional(),
  })
  .strict();

export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;

/** The config keys the app renders as editable, in display order. */
export const EDITABLE_CONFIG_KEYS = [
  "useVoiceMode",
  "provider",
  "region",
] as const;

/**
 * Parse `config.json` into a plain object. Returns `{}` when the file is
 * missing or unparsable so a fresh install reads as all-defaults and a write
 * starts from an empty object rather than crashing.
 */
function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty
  }
  return {};
}

/** Resolve `config.json` through the schema so defaults are filled in. */
function resolveConfig(configPath: string): MeetingBotConfig {
  const parsed = MeetingBotConfigSchema.safeParse(readConfigObject(configPath));
  return parsed.success ? parsed.data : MeetingBotConfigSchema.parse({});
}

/** The full resolved config for display, minus the realtime shared secret. */
export function readConfigView(configPath: string): ConfigView {
  const { verificationToken: _token, ...view } = resolveConfig(configPath);
  return view;
}

/**
 * Apply a partial update to the editable fields and persist it, merging into
 * the existing `config.json` so every other field (including keys the app does
 * not surface) is preserved. Returns the new read-only view.
 */
export function applyConfigUpdate(
  configPath: string,
  update: ConfigUpdate,
): ConfigView {
  const obj = readConfigObject(configPath);
  if (update.useVoiceMode !== undefined) obj.useVoiceMode = update.useVoiceMode;
  if (update.provider !== undefined) obj.provider = update.provider;
  if (update.region !== undefined) obj.region = update.region;
  writeFileSync(configPath, `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
  return readConfigView(configPath);
}
