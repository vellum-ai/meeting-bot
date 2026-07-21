/**
 * Request handlers backing the plugin's HTTP routes (`routes/*.ts`).
 *
 * The route files under `routes/` are thin wrappers that just call these. Each
 * handler resolves the plugin's own paths (config.json for settings,
 * data/sessions.json for history) internally, so callers never pass a
 * directory in. The underlying store/reader functions still take an explicit
 * path and are where the value-precise unit tests live.
 */

import {
  AppSettingsUpdateSchema,
  readAppSettings,
  updateAppSettings,
} from "./app-settings.ts";
import { readMeetingHistory } from "./meeting-history.ts";
import { pluginConfigPath, pluginDataDir } from "./plugin-paths.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** `GET /x/plugins/meeting-bot/meetings`: meeting history, newest first. */
export function handleMeetingsGet(): Response {
  return json(readMeetingHistory(pluginDataDir()));
}

/** `GET /x/plugins/meeting-bot/settings`: current editable settings. */
export function handleSettingsGet(): Response {
  return json(readAppSettings(pluginConfigPath()));
}

/**
 * `PATCH /x/plugins/meeting-bot/settings`: apply a partial settings update and
 * return the new settings. Rejects a non-JSON body or an invalid/unknown field
 * with 400.
 */
export async function handleSettingsPatch(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }

  const parsed = AppSettingsUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return json({ error: `invalid settings update: ${detail}` }, 400);
  }

  return json(updateAppSettings(pluginConfigPath(), parsed.data));
}
