/**
 * Meeting-platform detection from a join URL.
 *
 * The plugin has two providers (see `MEETING_PROVIDERS` in `config.ts`) and
 * they do NOT cover the same platforms:
 *
 *   - `recall` — Recall.ai drives the browser in their cloud. Their API
 *     accepts Meet, Zoom, and Teams URLs, so the join path passes the URL
 *     straight through and every platform below already works.
 *   - `vellum` — the Vellum Runtime drives our own Chromium via the
 *     meet-controller extension. That extension is Meet-specific
 *     (`host_permissions: https://meet.google.com/*`), so this provider
 *     is Meet-only today.
 *
 * Detection lives here, separate from either provider, so the join paths
 * can give a caller an accurate answer ("this provider can't do Zoom, the
 * other one can") instead of a generic "must be a Google Meet link".
 *
 * ## Zoom
 *
 * Zoom's sanctioned integration path is NOT browser automation. Zoom's
 * Meeting SDK terms reserve the SDK for human use cases and exclude bots
 * and AI notetakers outright; the supported route for real-time meeting
 * media is RTMS (Realtime Media Streams), a WebSocket API that streams
 * audio/video/transcript to an app without any participant joining the
 * call. RTMS is therefore the intended shape of a native `vellum` Zoom
 * implementation — an RTMS client, not a second browser bot — and it is
 * consent-driven (the user starts the app from inside Zoom) rather than
 * API-initiated the way a bot join is.
 *
 * Until that exists, Zoom URLs route to the `recall` provider.
 */

/** Platforms the plugin can recognize from a join URL. */
export const MEETING_PLATFORMS = ["meet", "zoom", "teams"] as const;
export type MeetingPlatform = (typeof MEETING_PLATFORMS)[number];

/**
 * Google Meet URL shape. Mirrors `meet_join`'s tool validation: a
 * three-part meeting code, optional query string, https only.
 */
export const MEET_URL_REGEX =
  /^https:\/\/meet\.google\.com\/[a-z]{3,4}-?[a-z]{4}-?[a-z]{3,4}(?:\?.*)?$/i;

/**
 * Zoom join URL shape. Covers the vanity/regional subdomain forms
 * (`us02web.zoom.us`, `acme.zoom.us`) and the three join paths Zoom
 * issues: `/j/<id>` (standard), `/w/<id>` (webinar), and `/my/<name>`
 * (personal room). The `?pwd=` query Zoom appends to one-click links is
 * preserved by callers — it is part of the credential, not decoration.
 */
export const ZOOM_URL_REGEX =
  /^https:\/\/(?:[a-z0-9-]+\.)*zoom\.(?:us|com)\/(?:j|w|my)\/[^/?#\s]+(?:\?.*)?$/i;

/**
 * Microsoft Teams join URL shape. Both the enterprise
 * (`teams.microsoft.com/l/meetup-join/...`) and consumer
 * (`teams.live.com/meet/...`) forms.
 */
export const TEAMS_URL_REGEX =
  /^https:\/\/teams\.(?:microsoft\.com\/l\/meetup-join|live\.com\/meet)\/[^\s]+$/i;

/**
 * Identify the platform a join URL belongs to. Returns `null` when the URL
 * matches no known platform — callers should treat that as "not a meeting
 * link" rather than guessing.
 */
export function detectMeetingPlatform(url: string): MeetingPlatform | null {
  const trimmed = url.trim();
  if (MEET_URL_REGEX.test(trimmed)) return "meet";
  if (ZOOM_URL_REGEX.test(trimmed)) return "zoom";
  if (TEAMS_URL_REGEX.test(trimmed)) return "teams";
  return null;
}

/** Human-readable platform name for error and status messages. */
export function meetingPlatformLabel(platform: MeetingPlatform): string {
  switch (platform) {
    case "meet":
      return "Google Meet";
    case "zoom":
      return "Zoom";
    case "teams":
      return "Microsoft Teams";
  }
}

/**
 * Platforms the Vellum Runtime can drive itself. Meet-only today: the
 * controller extension is scoped to `meet.google.com` and the join flow
 * is written against Meet's prejoin DOM.
 */
export const VELLUM_SUPPORTED_PLATFORMS: readonly MeetingPlatform[] = ["meet"];

/** True when the `vellum` provider can drive this platform natively. */
export function vellumSupportsPlatform(platform: MeetingPlatform): boolean {
  return VELLUM_SUPPORTED_PLATFORMS.includes(platform);
}

/**
 * Explain why the Vellum Runtime is refusing `meetingUrl`, with the
 * concrete next step. Returns `null` when the runtime accepts the URL.
 *
 * Kept as a message-builder (rather than inline strings at the call site)
 * so the dashboard route, the worker's `/join`, and the skill script all
 * refuse in the same words.
 */
export function vellumJoinRejection(meetingUrl: string): string | null {
  const platform = detectMeetingPlatform(meetingUrl);
  if (platform === null) {
    return (
      "meetingUrl must be a meeting link for a supported platform " +
      "(Google Meet, Zoom, or Microsoft Teams)"
    );
  }
  if (!vellumSupportsPlatform(platform)) {
    return (
      `the vellum provider cannot join ${meetingPlatformLabel(platform)} ` +
      `meetings — it drives Google Meet only. Switch the provider to ` +
      `'recall' to join this meeting.`
    );
  }
  return null;
}
