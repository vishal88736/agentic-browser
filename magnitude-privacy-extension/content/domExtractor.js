// content/domExtractor.js
// Runs in the page context. Produces the DOM/accessibility side of the
// "Unified UI Model" described in spec section 5. This never inspects
// field VALUES for text/password/etc. inputs — only structure — so the
// privacy gate can classify sensitivity without the DOM layer itself
// having read anything sensitive.

const INTERACTIVE_SELECTOR = [
  'input', 'textarea', 'select', 'button', 'a[href]',
  '[role="button"]', '[role="textbox"]', '[role="checkbox"]',
  '[role="radio"]', '[role="link"]', '[contenteditable="true"]'
].join(',');

function findLabelFor(el) {
  if (el.labels && el.labels.length) return el.labels[0].innerText.trim();
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const describedBy = el.getAttribute('aria-describedby');
  if (describedBy) {
    const node = document.getElementById(describedBy);
    if (node) return node.innerText.trim();
  }
  // Fall back to nearest preceding text (common form pattern).
  const prev = el.previousElementSibling;
  if (prev && prev.innerText && prev.innerText.trim().length < 80) {
    return prev.innerText.trim();
  }
  return undefined;
}

function isVisible(el) {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Snapshot the current viewport's interactive elements. bbox coordinates
 * are viewport-relative pixels, matching the coordinate space of
 * chrome.tabs.captureVisibleTab screenshots, so VLM bboxes and DOM bboxes
 * are directly comparable/mergeable.
 */
function extractDomFields() {
  const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const fields = [];

  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    const visible = isVisible(el);
    const tag = el.tagName.toLowerCase();

    fields.push({
      role: el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag),
      tag,
      inputType: tag === 'input' ? (el.getAttribute('type') || 'text') : undefined,
      name: el.getAttribute('name') || undefined,
      id: el.id || undefined,
      label: findLabelFor(el),
      placeholder: el.getAttribute('placeholder') || undefined,
      autocomplete: el.getAttribute('autocomplete') || undefined,
      disabled: !!el.disabled,
      visible,
      bbox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      // A stable-ish selector path for local action execution — never
      // sent remotely, resolved and used purely client-side.
      selectorPath: buildSelectorPath(el)
    });
  }

  return fields;
}

function buildSelectorPath(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 6) {
    let selector = node.tagName.toLowerCase();
    if (node.parentElement) {
      const siblings = Array.from(node.parentElement.children).filter(c => c.tagName === node.tagName);
      if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(selector);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

// Expose for content.js
window.__magnitudeExtractDomFields = extractDomFields;
