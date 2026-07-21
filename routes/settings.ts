/**
 * Settings routes for the config app, under `/x/plugins/meeting-bot/settings`:
 *   GET   returns the current editable settings
 *   PATCH applies a partial update, returns the new settings
 */

import { handleSettingsGet, handleSettingsPatch } from "../src/app-routes.ts";

export async function GET(_request: Request): Promise<Response> {
  return handleSettingsGet();
}

export async function PATCH(request: Request): Promise<Response> {
  return handleSettingsPatch(request);
}
