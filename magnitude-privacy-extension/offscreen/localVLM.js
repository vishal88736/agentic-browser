// offscreen/localVLM.js
//
// Local VLM provider. Runtime choice and rationale:
//
//   Magnitude itself (Node/Bun host) calls models through BAML-generated
//   clients (packages/magnitude-core/baml_src/*.baml -> generated
//   TS client), which assume an out-of-process model call (cloud API, or
//   an OpenAI-compatible local server). That's a fine model for a Node
//   CLI, but a Chrome extension has no Node runtime and (by MV3 policy)
//   cannot execute remotely-fetched *script* — so "spawn a local
//   llama.cpp/Ollama server and call it over HTTP" would work but would
//   silently defeat the "local-first, works with zero setup" goal and
//   adds an external process dependency outside the browser sandbox.
//
//   Given the actual runtime here is a browser extension, transformers.js
//   (bundled and vendored under ./vendor, no remote script execution) run
//   inside an offscreen document is the smallest integration that:
//     - runs fully in-process, in the extension's own sandboxed context
//     - supports WebGPU when available, falls back to WASM/CPU otherwise
//     - supports quantized (q4/q8/fp16) ONNX weights out of the box
//     - needs no external server/process the user has to manage
//
// The model itself is configurable (see options/options.js) rather than
// hardcoded. Default is a small vision-grounding model appropriate for
// UI screenshots; swap via LOCAL_VLM_MODEL for larger/smaller variants
// depending on device tier (see spec section 14).

import {
  AutoProcessor,
  AutoModelForVision2Seq,
  RawImage,
  env
} from './vendor/transformers.web.min.js';

// Never let transformers.js fall back to trying to load local Python-side
// converters etc. — browser-only.
env.allowLocalModels = false;

let processor = null;
let model = null;
let loadedModelId = null;

export async function loadModel({ modelId, device = 'auto', dtype = 'auto' } = {}) {
  if (loadedModelId === modelId && model) return { alreadyLoaded: true };

  const resolvedDevice = device === 'auto' ? (await hasWebGPU() ? 'webgpu' : 'wasm') : device;

  processor = await AutoProcessor.from_pretrained(modelId);
  model = await AutoModelForVision2Seq.from_pretrained(modelId, {
    device: resolvedDevice,
    dtype: dtype === 'auto' ? (resolvedDevice === 'webgpu' ? 'fp16' : 'q8') : dtype
  });

  loadedModelId = modelId;
  return { alreadyLoaded: false, device: resolvedDevice };
}

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/**
 * Runs local perception over a screenshot data URL. The prompt asks the
 * model for STRUCTURED output; since small local VLMs are not always
 * reliable JSON emitters, this is wrapped in the thin adapter
 * (parseStructuredOutput) called out in spec section 3's "Important" note
 * — rather than rearchitecting around the model's raw text output.
 *
 * @returns {Promise<LocalPerceptionResult>}
 */
export async function runLocalPerception(dataUrl, { domFieldsHint } = {}) {
  if (!model) throw new Error('Local VLM not loaded yet — call loadModel() first.');

  const image = await RawImage.fromURL(dataUrl);

  const prompt = buildGroundingPrompt(domFieldsHint);
  const inputs = await processor(image, prompt);
  const output = await model.generate({ ...inputs, max_new_tokens: 512 });
  const decoded = processor.batch_decode(output, { skip_special_tokens: true })[0];

  return parseStructuredOutput(decoded, image);
}

function buildGroundingPrompt(domFieldsHint) {
  const hint = domFieldsHint && domFieldsHint.length
    ? `The page's DOM reports ${domFieldsHint.length} interactive elements (buttons, inputs, links). Cross-reference them with what you see.`
    : '';
  return [
    'You are a UI perception model. Given this browser screenshot, list every',
    'visible interactive element (buttons, text fields, labels, dialogs,',
    'navigation) as compact JSON only, matching this TypeScript type:',
    '{ elements: Array<{ type: string, label?: string, text?: string,',
    '  bbox: {x:number,y:number,width:number,height:number}, sensitive: boolean,',
    '  sensitiveType?: string, confidence?: number }>, pageDescription?: string }.',
    'Mark `sensitive: true` for ANY field that could plausibly contain personal,',
    'financial, or identity data (names, IDs, passwords, OTPs, card numbers,',
    'DOB, addresses, uploaded documents) even if you cannot read the exact value.',
    'If unsure whether something is sensitive, set sensitive: true.',
    hint,
    'Respond with JSON only, no prose.'
  ].join(' ');
}

/**
 * Thin structured-output adapter (spec section 3, "add a thin adapter...
 * rather than changing the whole agent"). Handles the common local-model
 * failure modes: markdown code fences, trailing prose, truncated JSON.
 */
function parseStructuredOutput(raw, image) {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.elements)) throw new Error('missing elements[]');
    return normalizePerception(parsed, image);
  } catch (err) {
    // Conservative failure mode per spec section 8: if we can't parse a
    // confident structured result, treat the WHOLE screen as sensitive
    // rather than silently returning an empty/unsafe perception.
    return {
      elements: [{
        type: 'unknown_region',
        bbox: { x: 0, y: 0, width: image.width, height: image.height },
        sensitive: true,
        sensitiveType: 'unparsed_perception',
        confidence: 0
      }],
      pageDescription: undefined,
      parseError: String(err)
    };
  }
}

function normalizePerception(parsed, image) {
  return {
    pageDescription: typeof parsed.pageDescription === 'string' ? parsed.pageDescription : undefined,
    elements: parsed.elements.map(el => ({
      type: el.type || 'element',
      label: el.label,
      text: el.text,
      bbox: normalizeBbox(el.bbox, image),
      sensitive: el.sensitive !== false, // default-safe: undefined -> treated sensitive
      sensitiveType: el.sensitiveType,
      confidence: typeof el.confidence === 'number' ? el.confidence : 0.5
    }))
  };
}

function normalizeBbox(bbox, image) {
  if (!bbox) return { x: 0, y: 0, width: image.width, height: image.height };
  return {
    x: clamp(bbox.x, 0, image.width),
    y: clamp(bbox.y, 0, image.height),
    width: clamp(bbox.width, 0, image.width),
    height: clamp(bbox.height, 0, image.height)
  };
}

function clamp(n, min, max) {
  n = typeof n === 'number' && !Number.isNaN(n) ? n : min;
  return Math.max(min, Math.min(max, n));
}
