/**
 * Watches for the Meet tab navigating away from `meet.google.com` and
 * reports it to the bot as a `page_navigated` frame.
 *
 * Why the background service worker owns this: the content script dies
 * with the page on navigation, so it can never report where the tab went.
 * Observed failure mode (QA, 2026-07): after the trusted admission click,
 * Meet bounced the unauthenticated client to the marketing landing page
 * (`workspace.google.com/products/meet/`) — the content script vanished
 * silently and the bot sat blind until its 120s join deadline. The tabs
 * API sees the redirect the moment it happens.
 *
 * Tracking model: any tab whose URL matches `https://meet.google.com/*`
 * is tracked (last-seen Meet URL per tabId). When a tracked tab's URL
 * changes to something off-meet, we post `page_navigated` with both URLs
 * and stop tracking it. Intra-meet navigations just refresh the stored
 * URL. Closed tabs are evicted without a report — the content script's
 * own teardown / the bot's chrome-exit watcher covers tab death.
 */
import type { NativePort } from "./native-port.js";

/** Matches URLs the content script mounts on (`https://meet.google.com/*`). */
const MEET_URL_RE = /^https:\/\/meet\.google\.com\//;

/**
 * Minimal slice of `chrome.tabs` used by the watcher — structural so tests
 * can inject a fake without the chrome global.
 */
export interface NavWatcherTabsApi {
  onUpdated: {
    addListener: (
      cb: (
        tabId: number,
        changeInfo: { url?: string },
        tab: { url?: string },
      ) => void,
    ) => void;
  };
  onRemoved: {
    addListener: (cb: (tabId: number) => void) => void;
  };
}

/** Wire up Meet-tab navigation reporting for the life of the SW. */
export function startNavWatcher(
  port: NativePort,
  tabs: NavWatcherTabsApi,
): void {
  /** tabId → last-seen Meet URL for tabs currently on meet.google.com. */
  const meetTabs = new Map<number, string>();

  tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // `changeInfo.url` is only present on actual URL changes; `tab.url`
    // is the current URL either way. Prefer the change payload so loading
    // events without a URL change don't churn the map.
    const url = changeInfo.url ?? tab.url;
    if (url === undefined) return;

    if (MEET_URL_RE.test(url)) {
      meetTabs.set(tabId, url);
      return;
    }

    const fromUrl = meetTabs.get(tabId);
    if (fromUrl === undefined) return;
    meetTabs.delete(tabId);
    try {
      port.post({
        type: "page_navigated",
        url,
        fromUrl,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // Port down (bot restarting) — nothing to deliver to. The bot's own
      // watchers cover this window; don't let a report kill the SW.
      console.warn("[meet-ext] failed to report page navigation:", err);
    }
  });

  tabs.onRemoved.addListener((tabId) => {
    meetTabs.delete(tabId);
  });
}
