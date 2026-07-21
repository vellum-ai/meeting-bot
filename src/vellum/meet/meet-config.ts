import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MeetServiceSchema } from "./config-schema.js";
import type { MeetService } from "./config-schema.js";

/**
 * Path to the meet-specific config file relative to the workspace root.
 * The file is expected at `<workspaceDir>/config/meet.json`.
 */
const MEET_CONFIG_RELATIVE = "config/meet.json";

/**
 * Overrides layered on top of the file-based meet config. meeting-bot
 * consolidates the commonly tuned fields (join name, consent message,
 * container image) into its own plugin `config.json` under a `meet` section;
 * the Vellum Runtime installs those values here at startup so every internal
 * `getMeetConfig` call site picks them up without threading config through
 * the session manager. `<workspaceDir>/config/meet.json` remains the home of
 * the long-tail fields (avatar, proactive chat, voice mode, ...).
 */
export type MeetConfigOverrides = Partial<
  Pick<MeetService, "joinName" | "consentMessage" | "containerImage">
>;

let overrides: MeetConfigOverrides = {};

/** Install config overrides (subset consolidated into the plugin config). */
export function setMeetConfigOverrides(next: MeetConfigOverrides): void {
  overrides = next;
}

/**
 * Read and validate the meet config from
 * `<workspaceDir>/config/meet.json`. When the file is missing or
 * unparseable, schema defaults are returned so the skill always has a
 * valid config object. This decouples the meet skill's configuration
 * from the assistant's global `config.json` → `services.meet` path.
 *
 * Values installed via {@link setMeetConfigOverrides} (sourced from the
 * meeting-bot plugin's own config.json) win over the file.
 *
 * Callers pass the workspace directory they obtained from the host
 * (`host.platform.workspaceDir()`) or, in the session manager, from
 * `deps.getWorkspaceDir()`. Keeping the path input explicit avoids any
 * dependency from this file into `assistant/src/util/platform.js`.
 */
export function getMeetConfig(workspaceDir: string): MeetService {
  return { ...readMeetConfigFile(workspaceDir), ...definedOverrides() };
}

function definedOverrides(): MeetConfigOverrides {
  const result: MeetConfigOverrides = {};
  if (overrides.joinName !== undefined) result.joinName = overrides.joinName;
  if (overrides.consentMessage !== undefined) {
    result.consentMessage = overrides.consentMessage;
  }
  if (overrides.containerImage !== undefined) {
    result.containerImage = overrides.containerImage;
  }
  return result;
}

function readMeetConfigFile(workspaceDir: string): MeetService {
  const configPath = join(workspaceDir, MEET_CONFIG_RELATIVE);

  if (!existsSync(configPath)) {
    return MeetServiceSchema.parse({});
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return MeetServiceSchema.parse({});
  }

  const result = MeetServiceSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  // Invalid fields — fall back to defaults rather than crashing the skill.
  return MeetServiceSchema.parse({});
}
