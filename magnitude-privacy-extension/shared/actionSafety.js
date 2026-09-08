// shared/actionSafety.js
//
// Action-aware retry / recovery policy and execution-verification helpers
// (spec section 12, 9 — "keep sensitive actions local", and the retry
// decision table). The orchestrator must never blindly retry a potentially
// destructive or sensitive action, and must verify outcomes rather than
// assume success.

// Variants that are purely observational / low-risk and may be safely retried
// (re-read DOM, re-take screenshot, re-run perception, re-locate, scroll).
export const SAFE_TO_RETRY_VARIANTS = new Set([
  'mouse:scroll', 'keyboard:tab', 'browser:tab:switch'
]);

// Variants that mutate sensitive state or leak-domain state: never retried
// blindly. Either stop, or surface for explicit user confirmation.
export const SENSITIVE_OR_DESTRUCTIVE_VARIANTS = new Set([
  'local:fill_credential', // fills a secret resolved locally
  'browser:upload_file'    // uploads a private document
]);

// Phrases that make a click/type action destructive even though the variant
// token itself is neutral.
const DESTRUCTIVE_TARGET_HINTS = [
  'submit', 'pay', 'payment', 'confirm', 'send', 'delete', 'remove',
  'place_order', 'checkout', 'transfer', 'purchase', 'sign'
];

/**
 * Classify an action for retry purposes.
 *
 * @param {{variant:string, target?:any, content?:string}} action
 * @returns {{variant:string, retryable:boolean, requiresConfirmation:boolean, reason:string}}
 */
export function classifyActionForRetry(action) {
  const variant = action?.variant || 'unknown';

  if (SENSITIVE_OR_DESTRUCTIVE_VARIANTS.has(variant)) {
    return { variant, retryable: false, requiresConfirmation: true, reason: 'sensitive/destructive action (fills or uploads private data)' };
  }

  if (SAFE_TO_RETRY_VARIANTS.has(variant)) {
    return { variant, retryable: true, requiresConfirmation: false, reason: 'observational/low-risk action' };
  }

  // Neutral variants (mouse:click, keyboard:type, keyboard:enter, browser:navigate,
  // browser:tab:new) are retryable only if their target/content is not
  // destructive-looking.
  const haystack = [
    action?.target?.selectorPath,
    action?.target?.label,
    action?.content,
    JSON.stringify(action?.target || {})
  ].filter(Boolean).join(' ').toLowerCase();

  const looksDestructive = DESTRUCTIVE_TARGET_HINTS.some(h => haystack.includes(h));

  if (looksDestructive) {
    return { variant, retryable: false, requiresConfirmation: true, reason: 'action targets a submit/pay/send/delete style control' };
  }

  return { variant, retryable: true, requiresConfirmation: false, reason: 'neutral action' };
}

/**
 * Given the result of a failure, decide whether to retry, stop, or ask the
 * user. Mirrors the spec's recovery flow:
 *   failed -> capture fresh state -> check already-succeeded -> safe? retry :
 *   sensitive? confirm.
 *
 * `alreadySucceeded` is computed by the caller (visual/DOM verification).
 */
export function decideRecovery(action, { alreadySucceeded = false, attempt = 0, maxAttempts = 3 } = {}) {
  if (alreadySucceeded) {
    return { action: 'stop', reason: 'action already succeeded (verified locally)' };
  }
  const cls = classifyActionForRetry(action);
  if (!cls.retryable) {
    if (cls.requiresConfirmation) {
      return { action: 'confirm', reason: cls.reason };
    }
    return { action: 'stop', reason: cls.reason };
  }
  if (attempt >= maxAttempts) {
    return { action: 'stop', reason: 'retry budget exhausted' };
  }
  return { action: 'retry', reason: cls.reason };
}

// --- Execution verification helpers (spec section 11) -----------------------

/**
 * Verify a target element is actionable (exists, visible, enabled, not
 * obstructed). Pure decision function over a descriptor — testable without a
 * live DOM.
 *
 * @param {{exists?:boolean, visible?:boolean, enabled?:boolean, obstructed?:boolean}} state
 */
export function isActionableTarget(state = {}) {
  return !!(state.exists !== false && state.visible !== false && state.enabled !== false && state.obstructed !== true);
}

/**
 * Interpret a pre/post visual-or-DOM diff into a success verdict. Returns an
 * object the orchestrator can log/handle; `changed` is computed by the
 * caller's change-detection hash.
 */
export function interpretOutcome({ visuallyChanged, domChanged }) {
  const changed = !!visuallyChanged || !!domChanged;
  return {
    success: changed,
    confidence: (visuallyChanged && domChanged) ? 1 : changed ? 0.6 : 0.1,
    verdict: changed ? 'state_changed' : 'no_observable_change'
  };
}