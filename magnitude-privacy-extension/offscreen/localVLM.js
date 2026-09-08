// offscreen/localVLM.js
//
// Local VLM provider using transformers.js v4.
//
// Strategy: always use the high-level `pipeline` API which handles model
// class selection automatically for all architectures (Qwen2.5-VL,
// SmolVLM, BLIP, Florence-2, etc.). This avoids the "Unsupported model type"
// errors that occur when using AutoModelForVision2Seq directly with newer
// architectures that map to non-standard model classes.

import { pipeline, env, RawImage } from './vendor/transformers.web.min.js';

// Browser-only — do not attempt to load local Python-side models.
env.allowLocalModels = false;

let pipe = null;
let loadedModelId = null;

export async function loadModel({ modelId, device = 'auto', dtype = 'auto' } = {}) {
  if (!modelId) {
    throw new Error('No model ID configured. Set a Model ID in Settings, or leave blank to use DOM-only perception.');
  }
  if (loadedModelId === modelId && pipe) return { alreadyLoaded: true };

  const resolvedDevice = device === 'auto' ? (await hasWebGPU() ? 'webgpu' : 'wasm') : device;
  const resolvedDtype  = dtype  === 'auto' ? (resolvedDevice === 'webgpu' ? 'fp16' : 'q4')  : dtype;

  // 'image-to-text' is the transformers.js pipeline for VLMs (BLIP, Qwen2.5-VL, etc.)
  // Note: Python transformers calls this 'image-text-to-text' but transformers.js uses 'image-to-text'
  pipe = await pipeline('image-to-text', modelId, {
    device: resolvedDevice,
    dtype: resolvedDtype
  });

  loadedModelId = modelId;
  return { alreadyLoaded: false, device: resolvedDevice, dtype: resolvedDtype };
}

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/**
 * Runs local perception over a screenshot data URL.
 * Uses the transformers.js pipeline API which is architecture-agnostic.
 *
 * @returns {Promise<LocalPerceptionResult>}
 */
export async function runLocalPerception(dataUrl, { domFieldsHint } = {}) {
  if (!pipe) throw new Error('Local VLM not loaded yet — call loadModel() first.');

  const hint = domFieldsHint?.length
    ? `The DOM reports ${domFieldsHint.length} interactive elements. Use them to improve accuracy.`
    : '';

  const prompt = [
    'You are a UI perception model analyzing a browser screenshot.',
    'List every visible interactive element (buttons, inputs, links, dialogs, nav)',
    'as JSON only matching this exact type:',
    '{ elements: Array<{ type: string, label?: string, text?: string,',
    '  bbox: {x:number,y:number,width:number,height:number},',
    '  sensitive: boolean, sensitiveType?: string, confidence?: number }>,',
    '  pageDescription?: string }',
    'Mark sensitive:true for ANY field containing personal/financial/identity data.',
    'When unsure, default to sensitive:true.',
    hint,
    'Respond with JSON only — no prose, no markdown fences.'
  ].join(' ');

  // image-to-text pipeline: first arg is image URL, second is options
  const output = await pipe(dataUrl, {
    max_new_tokens: 768,
    // some models (BLIP) use forced_bos_token_id, others accept a text prompt
    ...(prompt ? { prompt } : {})
  });

  // pipeline returns [{ generated_text: "..." }]
  const raw = Array.isArray(output) ? (output[0]?.generated_text ?? '') : String(output);

  return parseStructuredOutput(raw, await getImageDimensions(dataUrl));
}

async function getImageDimensions(dataUrl) {
  try {
    const img = await RawImage.fromURL(dataUrl);
    return { width: img.width, height: img.height };
  } catch {
    return { width: 1280, height: 800 }; // safe fallback
  }
}

// ---- Structured output parser ------------------------------------------

function parseStructuredOutput(raw, dims) {
  let text = (raw || '').trim();

  // Strip markdown code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // Extract first JSON object
  const firstBrace = text.indexOf('{');
  const lastBrace  = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.elements)) throw new Error('missing elements[]');
    return normalizePerception(parsed, dims);
  } catch (err) {
    // Conservative failure mode: treat the whole screen as sensitive
    return {
      elements: [{
        type: 'unknown_region',
        bbox: { x: 0, y: 0, width: dims.width, height: dims.height },
        sensitive: true,
        sensitiveType: 'unparsed_perception',
        confidence: 0
      }],
      pageDescription: undefined,
      parseError: String(err)
    };
  }
}

function normalizePerception(parsed, dims) {
  return {
    pageDescription: typeof parsed.pageDescription === 'string' ? parsed.pageDescription : undefined,
    elements: parsed.elements.map(el => ({
      type: el.type || 'element',
      label: el.label,
      text: el.text,
      bbox: normalizeBbox(el.bbox, dims),
      sensitive: el.sensitive !== false,
      sensitiveType: el.sensitiveType,
      confidence: typeof el.confidence === 'number' ? el.confidence : 0.5
    }))
  };
}

function normalizeBbox(bbox, dims) {
  if (!bbox) return { x: 0, y: 0, width: dims.width, height: dims.height };
  return {
    x: clamp(bbox.x, 0, dims.width),
    y: clamp(bbox.y, 0, dims.height),
    width:  clamp(bbox.width,  0, dims.width),
    height: clamp(bbox.height, 0, dims.height)
  };
}

function clamp(n, min, max) {
  n = typeof n === 'number' && !Number.isNaN(n) ? n : min;
  return Math.max(min, Math.min(max, n));
}
