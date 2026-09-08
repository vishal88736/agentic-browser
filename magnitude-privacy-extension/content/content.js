// content/content.js
// The action-execution half of the "local action executor". Coordinate-
// based mouse actions (mirroring Magnitude's mouse:click / mouse:scroll)
// are dispatched via the background service worker using
// chrome.debugger's Input.dispatchMouseEvent, which is the closest
// analogue in an extension to the CDP-driven click Magnitude already
// uses (see connectors/browserConnector.ts + web/harness.ts upstream).
// This content script handles everything that's naturally DOM-shaped:
// snapshotting, typing into the currently-focused/target element, and
// file uploads.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'SNAPSHOT_DOM': {
      const fields = window.__magnitudeExtractDomFields();
      sendResponse({ fields, url: location.href, title: document.title });
      return false;
    }

    case 'ACTION_TYPE': {
      const el = resolveTarget(msg.target);
      if (!el) return sendResponse({ ok: false, error: 'target not found' });
      el.focus();
      insertText(el, msg.content);
      sendResponse({ ok: true });
      return false;
    }

    case 'ACTION_CLICK_ELEMENT': {
      const el = resolveTarget(msg.target);
      if (!el) return sendResponse({ ok: false, error: 'target not found' });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      sendResponse({ ok: true });
      return false;
    }

    case 'ACTION_KEY': {
      const el = document.activeElement;
      dispatchKey(el, msg.key);
      sendResponse({ ok: true });
      return false;
    }

    case 'ACTION_UPLOAD_FILE': {
      // The actual File object is constructed locally (background.js
      // resolves credentialRole -> local file handle) and handed in via a
      // DataTransfer. The remote model only ever sees `credentialRole`,
      // never a file name or path.
      const el = resolveTarget(msg.target);
      if (!el || el.tagName !== 'INPUT' || el.type !== 'file') {
        return sendResponse({ ok: false, error: 'target is not a file input' });
      }
      msg.fileBlobPromiseId; // handled by background via a follow-up message; see background/router.js
      sendResponse({ ok: true, note: 'delegate to background for File construction' });
      return false;
    }

    default:
      return false;
  }
});

function resolveTarget(target) {
  if (!target) return null;
  if (target.selectorPath) {
    const el = document.querySelector(target.selectorPath);
    if (el) return el;
  }
  if (target.bbox) {
    const { x, y, width, height } = target.bbox;
    return document.elementFromPoint(x + width / 2, y + height / 2);
  }
  return null;
}

function insertText(el, content) {
  if ('value' in el) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, content);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.innerText = content;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
}

function dispatchKey(el, key) {
  const target = el || document.body;
  const opts = { key, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
}
