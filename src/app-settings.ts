/**
 * The editable subset of the plugin config the configuration app exposes.
 *
 * These values live in the host-owned plugin `config.json` (the same file the
 * `init` hook reads via `InitContext.config`), not in a separate store: the app
 * reads them from there and writes edits back, merging into the existing config
 * object so unrelated fields (publicWsUrl, region, ...) are preserved.
 *
 * Nothing consumes these values to change behavior yet; a later change wires
 * `useVoiceMode` and `provider` into the join / voice-response paths.
 */

import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { MEETING_PROVIDERS, type MeetingProvider } from "./config.ts";

export interface AppSettings {
  useVoiceMode: boolean;
  provider: MeetingProvider;
}

/** Defaults, matching the config schema: voice off, provider recall. */
const DEFAULT_SETTINGS: AppSettings = { useVoiceMode: false, provider: "recall" };

/** Partial update accepted by the settings PATCH route. */
export const AppSettingsUpdateSchema = z
  .object({
    useVoiceMode: z.boolean().optional(),
    provider: z.enum(MEETING_PROVIDERS).optional(),
  })
  .strict();

export type AppSettingsUpdate = z.infer<typeof AppSettingsUpdateSchema>;

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

function isMeetingProvider(v: unknown): v is MeetingProvider {
  return (
    typeof v === "string" &&
    (MEETING_PROVIDERS as readonly string[]).includes(v)
  );
}

/** Read the editable settings out of `config.json`, defaulting each field. */
export function readAppSettings(configPath: string): AppSettings {
  const obj = readConfigObject(configPath);
  return {
    useVoiceMode:
      typeof obj.useVoiceMode === "boolean"
        ? obj.useVoiceMode
        : DEFAULT_SETTINGS.useVoiceMode,
    provider: isMeetingProvider(obj.provider)
      ? obj.provider
      : DEFAULT_SETTINGS.provider,
  };
}

/**
 * Apply a partial update to the editable settings and persist it, merging into
 * the existing `config.json` so every other config field is preserved. Fields
 * absent from the update keep their current value. Returns the new settings.
 */
export function updateAppSettings(
  configPath: string,
  update: AppSettingsUpdate,
): AppSettings {
  const obj = readConfigObject(configPath);
  if (update.useVoiceMode !== undefined) obj.useVoiceMode = update.useVoiceMode;
  if (update.provider !== undefined) obj.provider = update.provider;
  writeFileSync(configPath, `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
  return readAppSettings(configPath);
}
