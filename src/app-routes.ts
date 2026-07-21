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
  applyConfigUpdate,
  ConfigUpdateSchema,
  readConfigView,
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

/**
 * `GET /x/plugins/meeting-bot/settings`: the full resolved config for display
 * (minus the realtime shared secret). The app renders a few fields editable and
 * the rest read-only.
 */
export function handleSettingsGet(): Response {
  return json(readConfigView(pluginConfigPath()));
}

/**
 * `PATCH /x/plugins/meeting-bot/settings`: apply a partial update to the
 * editable fields and return the new view. Rejects a non-JSON body or an
 * invalid/unknown (i.e. non-editable) field with 400.
 */
export async function handleSettingsPatch(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }

  const parsed = ConfigUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return json({ error: `invalid config update: ${detail}` }, 400);
  }

  return json(applyConfigUpdate(pluginConfigPath(), parsed.data));
}
