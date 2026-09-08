// shared/actionSchema.js
//
// Deliberately mirrors the variant names used in Magnitude's
// packages/magnitude-core/src/actions/webActions.ts and actions/types.ts,
// so the reasoning model (local or remote) is speaking a schema this repo
// already validated works well for VLM-grounded action plans:
//   mouse:click, mouse:double_click, mouse:right_click, mouse:drag,
//   mouse:scroll, keyboard:type, keyboard:enter, keyboard:tab,
//   keyboard:backspace, keyboard:select_all, browser:tab:switch,
//   browser:tab:new
//
// One addition specific to this fork: `local:fill_credential`. This is
// the mechanism from section 9 of the spec — the server (or local
// planner) may request that a sensitive field be filled, but it names the
// credential by ROLE, never by value. Resolution to an actual value only
// ever happens inside the extension, locally.

export const ACTION_VARIANTS = [
  'mouse:click',
  'mouse:double_click',
  'mouse:right_click',
  'mouse:drag',
  'mouse:scroll',
  'keyboard:type',
  'keyboard:enter',
  'keyboard:tab',
  'keyboard:backspace',
  'keyboard:select_all',
  'browser:tab:switch',
  'browser:tab:new',
  'browser:navigate',
  'browser:upload_file',
  'local:fill_credential'
];

/**
 * Lightweight runtime validation (this extension avoids pulling in zod to
 * keep the unpacked bundle dependency-free; swap for zod if this package
 * is later built with a bundler).
 */
export function validateAction(action) {
  if (!action || typeof action !== 'object') {
    throw new Error('Action must be an object');
  }
  if (!ACTION_VARIANTS.includes(action.variant)) {
    throw new Error(`Unknown action variant: ${action.variant}`);
  }

  switch (action.variant) {
    case 'mouse:click':
    case 'mouse:double_click':
    case 'mouse:right_click':
      requireNumber(action, 'x');
      requireNumber(action, 'y');
      break;
    case 'mouse:drag':
      requireObject(action, 'from');
      requireObject(action, 'to');
      break;
    case 'mouse:scroll':
      requireNumber(action, 'x');
      requireNumber(action, 'y');
      requireNumber(action, 'deltaX');
      requireNumber(action, 'deltaY');
      break;
    case 'keyboard:type':
      requireString(action, 'content');
      break;
    case 'browser:tab:switch':
      requireNumber(action, 'index');
      break;
    case 'browser:navigate':
      requireString(action, 'url');
      break;
    case 'browser:upload_file':
      requireTarget(action);
      requireString(action, 'credentialRole'); // e.g. "aadhaar_document" — never a raw path from remote
      break;
    case 'local:fill_credential':
      requireTarget(action);
      requireString(action, 'credentialRole'); // e.g. "aadhaar_number", "otp", "password"
      break;
    default:
      break;
  }
  return true;
}

function requireNumber(obj, key) {
  if (typeof obj[key] !== 'number') throw new Error(`Action.${key} must be a number`);
}
function requireString(obj, key) {
  if (typeof obj[key] !== 'string') throw new Error(`Action.${key} must be a string`);
}
function requireObject(obj, key) {
  if (typeof obj[key] !== 'object' || obj[key] === null) throw new Error(`Action.${key} must be an object`);
}
function requireTarget(action) {
  requireObject(action, 'target');
  if (!action.target.selectorPath && !action.target.bbox) {
    throw new Error('Action.target must include a selectorPath or bbox');
  }
}

/**
 * Actions whose payload must NEVER be forwarded to a remote model or
 * logged verbatim (their `content` may contain a resolved secret after
 * local resolution).
 */
export const LOCAL_ONLY_VARIANTS = new Set(['local:fill_credential', 'browser:upload_file']);
