/**
 * Tests for the Google sign-in flow.
 *
 * The flow is driven against a JSDOM document standing in for
 * accounts.google.com. Timers are collapsed the same way `join.test.ts`
 * does so step timeouts resolve immediately instead of spinning for 20s.
 */

import { JSDOM } from "jsdom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  detectSignInBlocker,
  isSignInPage,
  runSignInFlow,
  signInSelectors,
} from "../features/sign-in.js";

const JSDOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "MutationObserver",
  "getComputedStyle",
] as const;

let sharedWindow: JSDOM["window"] | null = null;
const previousGlobals: Record<string, unknown> = {};

beforeAll(() => {
  const dom = new JSDOM("<html><body></body></html>", {
    runScripts: "outside-only",
  });
  sharedWindow = dom.window;
  for (const key of JSDOM_GLOBALS) {
    previousGlobals[key] = (globalThis as unknown as Record<string, unknown>)[
      key
    ];
    (globalThis as unknown as Record<string, unknown>)[key] = (
      sharedWindow as unknown as Record<string, unknown>
    )[key];
  }
});

afterAll(() => {
  for (const key of JSDOM_GLOBALS) {
    (globalThis as unknown as Record<string, unknown>)[key] =
      previousGlobals[key];
  }
  sharedWindow = null;
});

type GlobalSetTimeout = (
  cb: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
) => ReturnType<typeof setTimeout>;

let originalSetTimeout: GlobalSetTimeout | null = null;

beforeEach(() => {
  originalSetTimeout = globalThis.setTimeout as unknown as GlobalSetTimeout;
  const patched: GlobalSetTimeout = (cb, ms, ...args) => {
    const real = originalSetTimeout as GlobalSetTimeout;
    if (typeof ms === "number" && ms >= 500) return real(cb, 0, ...args);
    return real(cb, ms, ...args);
  };
  (globalThis as unknown as { setTimeout: GlobalSetTimeout }).setTimeout =
    patched;
});

afterEach(() => {
  if (originalSetTimeout !== null) {
    (globalThis as unknown as { setTimeout: GlobalSetTimeout }).setTimeout =
      originalSetTimeout;
    originalSetTimeout = null;
  }
});

/** A JSDOM document carrying Google's two-step login form. */
function loginDom(): Document {
  const dom = new JSDOM(
    `<html><body>
      <input type="email" id="identifierId" />
      <div id="identifierNext"><button>Next</button></div>
      <input type="password" name="Passwd" />
      <div id="passwordNext"><button>Next</button></div>
    </body></html>`,
    { runScripts: "outside-only" },
  );
  return dom.window.document;
}

const TEST_WINDOW = {
  screenX: 0,
  screenY: 0,
  outerHeight: 800,
  innerHeight: 720,
};

describe("isSignInPage", () => {
  test("matches the Google accounts origin only", () => {
    expect(isSignInPage("https://accounts.google.com/ServiceLogin")).toBe(true);
    expect(isSignInPage("https://accounts.google.com/v3/signin/identifier")).toBe(
      true,
    );
    expect(isSignInPage("https://meet.google.com/abc-defg-hij")).toBe(false);
    expect(isSignInPage("https://accounts.google.com.evil.test/x")).toBe(false);
  });
});

describe("detectSignInBlocker", () => {
  test("returns null on a clean login page", () => {
    expect(detectSignInBlocker(loginDom())).toBeNull();
  });

  test("names each blocking state", () => {
    const cases: Array<[string, RegExp]> = [
      ["2-Step Verification", /2-Step Verification/i],
      ["Verify it's you", /device challenge/i],
      ["Couldn't sign you in", /refused the sign-in/i],
      ["This browser or app may not be secure", /insecure\/automated/i],
      ["Wrong password. Try again", /password was rejected/i],
      ["Couldn't find your Google Account", /does not match/i],
    ];
    for (const [text, expected] of cases) {
      const dom = new JSDOM(`<html><body><div>${text}</div></body></html>`);
      const reason = detectSignInBlocker(dom.window.document);
      expect(reason).not.toBeNull();
      expect(reason!).toMatch(expected);
    }
  });
});

describe("runSignInFlow", () => {
  test("types the account and clicks through both steps", async () => {
    const doc = loginDom();
    const events: Array<Record<string, unknown>> = [];

    await runSignInFlow({
      email: "bot@example.com",
      password: "s3cret",
      onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
      doc,
      window: TEST_WINDOW,
    });

    // Both secrets are typed via the trusted path, in order.
    const typed = events
      .filter((e) => e.type === "trusted_type")
      .map((e) => e.text);
    expect(typed).toEqual(["bot@example.com", "s3cret"]);

    // Four trusted clicks: focus email, Next, focus password, Next.
    const clicks = events.filter((e) => e.type === "trusted_click");
    expect(clicks.length).toBe(4);

    // Coordinates include the chrome offset (outerHeight - innerHeight).
    for (const click of clicks) {
      expect(typeof click.x).toBe("number");
      expect(typeof click.y).toBe("number");
    }
  });

  test("fails with an actionable message when 2FA blocks the account", async () => {
    const doc = loginDom();
    doc.body.appendChild(
      Object.assign(doc.createElement("div"), {
        textContent: "2-Step Verification",
      }),
    );
    const events: Array<Record<string, unknown>> = [];

    await expect(
      runSignInFlow({
        email: "bot@example.com",
        password: "s3cret",
        onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
        doc,
        window: TEST_WINDOW,
      }),
    ).rejects.toThrow(/2-Step Verification/i);

    // Nothing was typed — the blocker is detected before any secret is
    // pushed into the page.
    expect(events.some((e) => e.type === "trusted_type")).toBe(false);
  });

  test("reports a rejected password after submission", async () => {
    const doc = loginDom();
    const events: Array<Record<string, unknown>> = [];

    // The password step's Next click is what surfaces the error, so the
    // blocker text is added when the second Next is clicked.
    const passwordNext = doc.querySelector(
      signInSelectors.PASSWORD_NEXT,
    ) as HTMLElement;
    const original = passwordNext.click.bind(passwordNext);
    passwordNext.click = () => {
      doc.body.appendChild(
        Object.assign(doc.createElement("div"), {
          textContent: "Wrong password. Try again",
        }),
      );
      original();
    };

    await expect(
      runSignInFlow({
        email: "bot@example.com",
        password: "wrong",
        onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
        doc,
        window: TEST_WINDOW,
      }),
    ).rejects.toThrow(/password was rejected/i);
  });
});
