/**
 * Unit tests for the background nav-watcher.
 *
 * Fake `chrome.tabs` and a fake native port let us drive onUpdated /
 * onRemoved sequences and assert exactly which navigations produce a
 * `page_navigated` frame.
 */

import { describe, expect, test } from "bun:test";

import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";

import type { NativePort } from "../messaging/native-port.js";
import {
  startNavWatcher,
  type NavWatcherTabsApi,
} from "../messaging/nav-watcher.js";

interface FakePort {
  port: NativePort;
  posted: ExtensionToBotMessage[];
  setThrowOnPost: (v: boolean) => void;
}

function makeFakePort(): FakePort {
  const posted: ExtensionToBotMessage[] = [];
  let throwOnPost = false;
  const port = {
    post: (msg: ExtensionToBotMessage): void => {
      if (throwOnPost) throw new Error("native port not connected");
      posted.push(msg);
    },
    onMessage: (): void => undefined,
    onConnect: (): void => undefined,
    onDisconnect: (): void => undefined,
    close: (): void => undefined,
  } as unknown as NativePort;
  return { port, posted, setThrowOnPost: (v) => (throwOnPost = v) };
}

interface FakeTabs {
  api: NavWatcherTabsApi;
  fireUpdated: (
    tabId: number,
    changeInfo: { url?: string },
    tab?: { url?: string },
  ) => void;
  fireRemoved: (tabId: number) => void;
}

function makeFakeTabs(): FakeTabs {
  let updatedCb:
    | ((
        tabId: number,
        changeInfo: { url?: string },
        tab: { url?: string },
      ) => void)
    | null = null;
  let removedCb: ((tabId: number) => void) | null = null;
  return {
    api: {
      onUpdated: {
        addListener: (cb) => {
          updatedCb = cb;
        },
      },
      onRemoved: {
        addListener: (cb) => {
          removedCb = cb;
        },
      },
    },
    fireUpdated: (tabId, changeInfo, tab = {}) =>
      updatedCb?.(tabId, changeInfo, tab),
    fireRemoved: (tabId) => removedCb?.(tabId),
  };
}

const MEET_URL = "https://meet.google.com/abc-defg-hij";
const LANDING_URL = "https://workspace.google.com/products/meet/";

describe("startNavWatcher", () => {
  test("reports a tracked Meet tab navigating off meet.google.com", () => {
    const { port, posted } = makeFakePort();
    const tabs = makeFakeTabs();
    startNavWatcher(port, tabs.api);

    tabs.fireUpdated(1, { url: MEET_URL });
    expect(posted.length).toBe(0);

    tabs.fireUpdated(1, { url: LANDING_URL });
    expect(posted.length).toBe(1);
    const msg = posted[0]!;
    expect(msg.type).toBe("page_navigated");
    if (msg.type === "page_navigated") {
      expect(msg.url).toBe(LANDING_URL);
      expect(msg.fromUrl).toBe(MEET_URL);
      expect(msg.timestamp.length).toBeGreaterThan(0);
    }
  });

  test("intra-Meet navigation refreshes tracking without a report", () => {
    const { port, posted } = makeFakePort();
    const tabs = makeFakeTabs();
    startNavWatcher(port, tabs.api);

    tabs.fireUpdated(1, { url: "https://meet.google.com/landing" });
    tabs.fireUpdated(1, { url: MEET_URL });
    expect(posted.length).toBe(0);

    // The report carries the LATEST Meet URL as fromUrl.
    tabs.fireUpdated(1, { url: LANDING_URL });
    expect(posted.length).toBe(1);
    const msg = posted[0]!;
    if (msg.type === "page_navigated") {
      expect(msg.fromUrl).toBe(MEET_URL);
    }
  });

  test("never-tracked tabs and repeat off-meet updates stay silent", () => {
    const { port, posted } = makeFakePort();
    const tabs = makeFakeTabs();
    startNavWatcher(port, tabs.api);

    // A tab that was never on Meet navigates around — no report.
    tabs.fireUpdated(7, { url: "https://example.com/" });
    expect(posted.length).toBe(0);

    // Tracked tab leaves Meet: one report, then further off-meet updates
    // on the same (now-untracked) tab stay silent.
    tabs.fireUpdated(1, { url: MEET_URL });
    tabs.fireUpdated(1, { url: LANDING_URL });
    tabs.fireUpdated(1, { url: "https://accounts.google.com/signin" });
    expect(posted.length).toBe(1);
  });

  test("uses tab.url when changeInfo has no url", () => {
    const { port, posted } = makeFakePort();
    const tabs = makeFakeTabs();
    startNavWatcher(port, tabs.api);

    tabs.fireUpdated(1, {}, { url: MEET_URL });
    tabs.fireUpdated(1, {}, { url: LANDING_URL });
    expect(posted.length).toBe(1);
  });

  test("removed tabs are evicted without a report", () => {
    const { port, posted } = makeFakePort();
    const tabs = makeFakeTabs();
    startNavWatcher(port, tabs.api);

    tabs.fireUpdated(1, { url: MEET_URL });
    tabs.fireRemoved(1);
    // Chrome can reuse tab ids; a fresh tab with the same id navigating
    // off-meet must not report against the stale Meet URL.
    tabs.fireUpdated(1, { url: LANDING_URL });
    expect(posted.length).toBe(0);
  });

  test("a disconnected port does not throw out of the listener", () => {
    const { port, posted, setThrowOnPost } = makeFakePort();
    const tabs = makeFakeTabs();
    startNavWatcher(port, tabs.api);

    tabs.fireUpdated(1, { url: MEET_URL });
    setThrowOnPost(true);
    expect(() => tabs.fireUpdated(1, { url: LANDING_URL })).not.toThrow();
    expect(posted.length).toBe(0);
  });
});
