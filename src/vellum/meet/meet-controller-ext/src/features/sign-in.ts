/**
 * Google account sign-in, driven from the accounts.google.com page world.
 *
 * Why this exists: Meet hard-denies anonymous automated clients at knock
 * submission (see `bot/AGENTS.md`), so the bot signs in as a dedicated
 * account before it ever reaches the meeting. Chrome is launched at
 * `accounts.google.com/ServiceLogin?continue=<meetUrl>`, so a successful
 * sign-in — or an already-signed-in persistent profile — lands on the
 * meeting with no extra navigation from us.
 *
 * Google's login is a two-step React form: email → Next → password →
 * Next. Both fields are controlled inputs and the buttons are gated the
 * same way Meet's are, so this reuses the bot's trusted-input machinery
 * (`trusted_type` / `trusted_click`) rather than dispatching synthetic
 * events that Google would ignore.
 *
 * ## What this deliberately does NOT handle
 *
 * 2FA, "verify it's you" device challenges, CAPTCHA, and consent
 * interstitials. Each is a hard stop that no amount of DOM driving can
 * clear, so they are detected and reported as actionable errors rather
 * than retried: the fix is account configuration (app password, disabled
 * 2FA, a pre-warmed profile), not more automation.
 */
import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";
import { isInteractable, waitForSelector } from "../dom/wait.js";

/** How long to wait for each step of the login form to mount. */
const STEP_TIMEOUT_MS = 20_000;

/** How long to wait for the post-password navigation to begin. */
const SUBMIT_SETTLE_MS = 3_000;

/**
 * Selectors for Google's login form. Google's DOM is obfuscated but these
 * three anchors have been stable for years: the input `type`/`name`, and
 * the `#identifierNext` / `#passwordNext` button wrappers.
 */
export const signInSelectors = {
  EMAIL_INPUT: 'input[type="email"], input#identifierId',
  EMAIL_NEXT: '#identifierNext button, #identifierNext [role="button"]',
  PASSWORD_INPUT: 'input[type="password"][name="Passwd"], input[type="password"]',
  PASSWORD_NEXT: '#passwordNext button, #passwordNext [role="button"]',
} as const;

/**
 * Page states that mean "a human has to intervene". Matched against the
 * visible text of the page, lowercased. Kept as fragments because Google
 * localizes and rewords these constantly.
 */
const BLOCKING_FRAGMENTS: ReadonlyArray<{ fragment: string; reason: string }> = [
  { fragment: "2-step verification", reason: "2-Step Verification is enabled" },
  { fragment: "verify it's you", reason: "Google issued a device challenge" },
  { fragment: "verify it’s you", reason: "Google issued a device challenge" },
  {
    fragment: "couldn't sign you in",
    reason: "Google refused the sign-in (often automation detection)",
  },
  {
    fragment: "couldn’t sign you in",
    reason: "Google refused the sign-in (often automation detection)",
  },
  {
    fragment: "this browser or app may not be secure",
    reason: "Google flagged the browser as insecure/automated",
  },
  { fragment: "wrong password", reason: "the stored password was rejected" },
  {
    fragment: "couldn't find your google account",
    reason: "the stored email does not match a Google account",
  },
];

export interface RunSignInOptions {
  /** Bot account email. */
  email: string;
  /** Bot account password. */
  password: string;
  /** Sink for extension→bot frames (trusted input + diagnostics). */
  onEvent: (msg: ExtensionToBotMessage) => void;
  /** Document to drive. Defaults to the live document; tests inject JSDOM. */
  doc?: Document;
  /** Window used for screen-space coordinate math. See `join.ts`. */
  window?: {
    screenX: number;
    screenY: number;
    outerHeight: number;
    innerHeight: number;
  };
}

/** Emit a diagnostic error then throw — mirrors `join.ts`'s `fail`. */
function fail(
  onEvent: (msg: ExtensionToBotMessage) => void,
  message: string,
): never {
  onEvent({ type: "diagnostic", level: "error", message });
  throw new Error(message);
}

/**
 * Detect a page state that sign-in automation cannot clear. Returns the
 * human-readable reason, or null when the page looks drivable.
 */
export function detectSignInBlocker(doc: Document): string | null {
  const text = (doc.body?.textContent ?? "").toLowerCase();
  if (text.length === 0) return null;
  for (const { fragment, reason } of BLOCKING_FRAGMENTS) {
    if (text.includes(fragment)) return reason;
  }
  return null;
}

/** True when the current page is Google's account sign-in surface. */
export function isSignInPage(url: string): boolean {
  return /^https:\/\/accounts\.google\.com\//i.test(url);
}

/**
 * Click `element` as a real X-server click by asking the bot to run
 * xdotool at the element's screen coordinates. Identical math to
 * `join.ts`'s `dispatchAdmissionClick` — see the assumptions block there.
 */
function trustedClick(
  element: Element,
  onEvent: (msg: ExtensionToBotMessage) => void,
  win: { screenX: number; screenY: number; outerHeight: number; innerHeight: number },
): void {
  const rect = (element as HTMLElement).getBoundingClientRect();
  const chromeOffsetY = Math.max(0, win.outerHeight - win.innerHeight);
  const x = Math.round((win.screenX ?? 0) + rect.left + rect.width / 2);
  const y = Math.round(
    (win.screenY ?? 0) + chromeOffsetY + rect.top + rect.height / 2,
  );
  onEvent({ type: "trusted_click", x, y });
  (element as HTMLElement).click();
}

/**
 * Wait for an interactable match, surfacing a blocker if one appeared
 * while we waited. Returns the element.
 */
async function awaitStep(
  selector: string,
  doc: Document,
  onEvent: (msg: ExtensionToBotMessage) => void,
  label: string,
): Promise<Element> {
  try {
    return await waitForSelector(selector, STEP_TIMEOUT_MS, doc, {
      interactable: true,
    });
  } catch {
    const blocker = detectSignInBlocker(doc);
    if (blocker !== null) {
      fail(
        onEvent,
        `meet-ext: Google sign-in cannot continue — ${blocker}. ` +
          `The bot account must be able to sign in unattended: disable 2-Step ` +
          `Verification on it, or sign in once by hand so the persistent ` +
          `Chrome profile carries the session.`,
      );
    }
    fail(
      onEvent,
      `meet-ext: Google sign-in timed out waiting for ${label} after ${STEP_TIMEOUT_MS}ms`,
    );
  }
}

/**
 * Drive Google's two-step login form to completion.
 *
 * Resolves once the password has been submitted — the page then navigates
 * to the `continue` target (the meeting), and the Meet content script
 * takes over from there. Rejects with an actionable message on any
 * blocker.
 */
export async function runSignInFlow(opts: RunSignInOptions): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.window ??
    doc.defaultView ?? { screenX: 0, screenY: 0, outerHeight: 0, innerHeight: 0 };
  const { onEvent } = opts;

  // A blocker can be on the page before we touch anything (e.g. the
  // profile is mid-challenge from a previous attempt).
  const upfront = detectSignInBlocker(doc);
  if (upfront !== null) {
    fail(
      onEvent,
      `meet-ext: Google sign-in cannot continue — ${upfront}.`,
    );
  }

  onEvent({
    type: "diagnostic",
    level: "info",
    message: "meet-ext: signing the bot account in to Google",
  });

  // Step 1 — email. Focus first: `trusted_type` types into whatever the
  // X server considers focused, so the click is what selects the target.
  const emailInput = await awaitStep(
    signInSelectors.EMAIL_INPUT,
    doc,
    onEvent,
    "the email field",
  );
  (emailInput as HTMLInputElement).focus();
  trustedClick(emailInput, onEvent, win);
  onEvent({ type: "trusted_type", text: opts.email });

  const emailNext = await awaitStep(
    signInSelectors.EMAIL_NEXT,
    doc,
    onEvent,
    "the email Next button",
  );
  trustedClick(emailNext, onEvent, win);

  // Step 2 — password. Google animates the password field in after the
  // email step resolves, so this wait covers the transition too.
  const passwordInput = await awaitStep(
    signInSelectors.PASSWORD_INPUT,
    doc,
    onEvent,
    "the password field",
  );
  (passwordInput as HTMLInputElement).focus();
  trustedClick(passwordInput, onEvent, win);
  onEvent({ type: "trusted_type", text: opts.password });

  const passwordNext = await awaitStep(
    signInSelectors.PASSWORD_NEXT,
    doc,
    onEvent,
    "the password Next button",
  );
  trustedClick(passwordNext, onEvent, win);

  // Give Google a moment to either navigate away (success) or render a
  // challenge (failure we can name).
  await new Promise((r) => setTimeout(r, SUBMIT_SETTLE_MS));
  const post = detectSignInBlocker(doc);
  if (post !== null) {
    fail(
      onEvent,
      `meet-ext: Google rejected the bot account sign-in — ${post}.`,
    );
  }

  onEvent({
    type: "diagnostic",
    level: "info",
    message:
      "meet-ext: sign-in submitted; waiting for Google to continue to the meeting",
  });
}

/** Re-exported for the content script's mount-time branch. */
export { isInteractable };
