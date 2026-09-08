# Magnitude Local-First Privacy Agent — Chrome Extension

This is a Chrome (MV3) extension port of the local-first, privacy-preserving
browser agent design, built by re-implementing the relevant seams of the
[Magnitude browser-agent](https://github.com/magnitudedev/browser-agent)
repository inside an extension runtime.

## 1. What I actually found in Magnitude (read the source, not the README)

Magnitude is a **Node/Bun library + CLI**, not a browser extension:

- Browser control goes through `packages/magnitude-core/src/connectors/browserConnector.ts`
  and `web/harness.ts`, driving a real browser instance (CDP-based) from
  Node — screenshots are taken and coordinate-based actions
  (`mouse:click`, `keyboard:type`, `mouse:scroll`, `browser:tab:switch`, …)
  are dispatched from `actions/webActions.ts`.
- Model calls do **not** go through hand-written prompts + `fetch`. They go
  through **BAML** (`baml_src/*.baml`), a separate DSL compiled to a
  generated Rust/native client (`ai/modelHarness.ts`, `ai/types.ts`
  enumerate supported providers: `anthropic`, `openai`, `openai-generic`,
  `google-ai`, `vertex-ai`, `aws-bedrock`, `azure-openai`, `claude-code`).
  Model/provider switching is already supported — `openai-generic` is the
  existing "point at any OpenAI-compatible endpoint" escape hatch,
  including self-hosted/local servers.
- There is **no existing local in-process VLM inference** and no existing
  Chrome-extension packaging. Both are new for this fork.
- Actions are grounded on **screenshot coordinates**, with DOM/accessibility
  data not used as the primary signal (I did not find a DOM-first
  perception path in `web/` or `connectors/` — grounding is visual-first).

### Why this can't be "Magnitude, just running as an extension"

BAML's runtime is a compiled native/WASM component generated at build time
from `.baml` files — it isn't something that can execute inside a Chrome
extension's JS sandbox without a much larger porting project, and Node's
CDP-based browser driving has no analogue inside the browser itself (an
extension *is* the browser, it doesn't attach to a separate browser
process over CDP the way Magnitude's Node host does — though it can get a
similar effect via `chrome.debugger`, which is what's used here).

So this implementation:
- **Keeps** Magnitude's action vocabulary (`shared/actionSchema.js` mirrors
  `actions/webActions.ts`'s variant names 1:1 where the concepts carry
  over) and its visual-first, coordinate-grounded action style.
- **Keeps** the `openai-generic` provider *shape* (`model`, `baseUrl`
  → `endpoint`, `apiKey`) for the optional remote reasoning call, so an
  existing Magnitude-compatible endpoint can be reused.
- **Replaces** BAML with a plain structured-output JSON prompt + parser,
  and replaces CDP-from-Node with `chrome.debugger`/content-script-based
  execution, because those are the mechanisms actually available inside
  an extension.
- **Adds** everything the spec asks for that Magnitude doesn't have at
  all: local VLM inference, DOM/accessibility hybrid perception, the
  privacy gate, sanitization, and local-only credential resolution.

## 2. Architecture

```
popup ── START_TASK ──▶ background/background.js (orchestrator)
                              │
                    chrome.tabs.captureVisibleTab ──▶ screenshot
                    chrome.tabs.sendMessage(SNAPSHOT_DOM) ──▶ content/domExtractor.js
                              │
                    router.js: cheap perceptual hash ──▶ reuse cache? skip VLM
                              │ (else)
                    offscreen/offscreen.js ──▶ offscreen/localVLM.js (transformers.js, local, in-process)
                              │
                    shared/privacyGate.js  (VLM + DOM + shared/detectors.js regex/context rules)
                              │
                    ┌─────────┴─────────┐
                    local heuristic plan   remote reasoning (optional, sanitized only)
              background/background.js#planLocally   background/remoteClient.js
                    └─────────┬─────────┘
                              │
                    shared/actionSchema.js validation
                              │
                    executeAction(): chrome.debugger (coordinate clicks),
                    chrome.tabs.sendMessage (type/click-element/upload),
                    local credential vault (chrome.storage.local) resolved
                    ONLY inside background.js/content.js, never sent remotely
```

### File map

| Concern | File | Spec section |
|---|---|---|
| Local VLM adapter | `offscreen/localVLM.js` | 3, 4 |
| Offscreen host (WebGPU/canvas needs a DOM context, not just a worker) | `offscreen/offscreen.html`, `offscreen/offscreen.js` | 3 |
| DOM/accessibility extraction | `content/domExtractor.js` | 5 |
| Unified perception → decision | `shared/privacyGate.js` | 6, 8 |
| Regex/context/DOM detectors | `shared/detectors.js` | 6.1 |
| Screenshot redaction | `shared/sanitize.js` | 7 |
| Action schema + local-only actions | `shared/actionSchema.js` | 9, 10, 12 |
| Remote reasoning (sanitized-only) | `background/remoteClient.js` | 11 |
| Routing policy + change-detection cache | `background/router.js` | 13, 14, 15 |
| Orchestrator / action executor | `background/background.js` | 2, 9, 12, 17 |
| Config + credential vault UI | `options/` | 3, 9 |
| Task control UI | `popup/` | — |
| Tests | `tests/privacy.test.js` | 16 |

## 3. Install & run

```bash
# 1. Vendor transformers.js (already done in this bundle under
#    offscreen/vendor/transformers.web.min.js — re-run only if you need
#    to update the version):
npm install @huggingface/transformers --ignore-scripts
cp node_modules/@huggingface/transformers/dist/transformers.web.min.js \
   offscreen/vendor/transformers.web.min.js

# 2. Load unpacked in Chrome:
#    chrome://extensions → Developer mode → Load unpacked → select this folder
```

On first run, `chrome.offscreen` creates the hidden document, which loads
the configured model **from Hugging Face Hub over the network** (weights
only — no remote *code* execution, which MV3 disallows) and caches it in
the browser's Cache Storage for fully offline reuse afterward. This is the
one network dependency for an otherwise fully local perception step.

## 4. Configuring the model

Open the extension's **Settings** (popup → "Settings", or
`chrome://extensions` → Details → Extension options):

- `LOCAL_VLM_MODEL` — any transformers.js-compatible vision-language
  model id. **Verify against the current transformers.js model list
  before shipping** — `offscreen/localVLM.js` uses
  `AutoModelForVision2Seq`, which fits many VLM architectures but not
  all (some, like Florence-2, may need a model-specific class/prompt
  format). Treat the default id in `background/router.js` as a
  starting point to validate, not a guaranteed-working pin.
- `LOCAL_VLM_DEVICE` — `auto` (WebGPU if available, else WASM/CPU),
  or force one.
- `LOCAL_VLM_DTYPE` — `auto`, `fp16`, `q8`, `q4`.
- `REMOTE_ENDPOINT` / `REMOTE_MODEL` / `REMOTE_API_KEY` — optional,
  OpenAI-compatible. Leave `REMOTE_ENDPOINT` empty to run fully local-only
  (remote calls become impossible, not just discouraged).

## 5. Testing the privacy flow

```bash
node --test tests/privacy.test.js
```

Covers: Aadhaar detection with/without context, PAN format detection,
password/file DOM classification, "sanitized context never contains raw
sensitive text", "uncertain VLM output stays sensitive rather than
defaulting safe", DOM-only-adds-sensitivity, and that
`local:fill_credential` actions are structurally forbidden from carrying
a raw value.

To manually verify end-to-end: open `chrome://extensions` → this
extension → **Inspect views: service worker**, run a task against a form
containing an Aadhaar/password field, and confirm in the Network tab that
no request to `REMOTE_ENDPOINT` contains the raw value — only the
`sanitizedContext` string and a redacted screenshot (compare pixel region
against the on-screen field).

## 6. What's still missing for production

- **Credential vault encryption.** `chrome.storage.local` is plaintext at
  rest. Wrap `resolveCredential`/the vault writer with WebCrypto
  (`crypto.subtle`, AES-GCM, key derived from a user passphrase via
  PBKDF2/Argon2-in-WASM) before storing anything beyond a demo.
- **Model-specific prompt/output adapters.** `localVLM.js`'s prompt and
  parsing are generic; real deployment needs per-model tuning (few-shot
  examples, grammar-constrained decoding if the runtime supports it) to
  hit reliable JSON compliance, plus a fallback OCR pass (e.g.
  Tesseract.js) for devices where the VLM can't run at all (spec's
  "low-end device" tier in section 14).
  - No adaptive device-tier model switching yet — section 14's
    tiering is stubbed as a single configurable model; wire up a
    `navigator.deviceMemory`/WebGPU-adapter check → tier → model-id
    table once you have benchmark data (see below) to size the tiers.
- **`planLocally` is a minimal heuristic**, not a real local reasoning
  model — it only handles "fill a recognizable sensitive field from the
  vault." A genuinely useful local-only mode needs either a small
  local LLM/VLM fine-tuned for action planning, or a much larger rule
  library.
- **`mouse:scroll` execution** currently just scrolls the target into
  view; wire up `chrome.debugger`'s `Input.dispatchMouseWheelEvent` for
  true coordinate-based scroll deltas to match the schema.
- **No retry/error-recovery loop**, no screenshot diffing to confirm an
  action actually had the intended effect (Magnitude's own harness has
  stability/verification logic in `web/stability.ts` worth porting).
- **No automated redaction-region visual test** (the "does the black box
  actually cover the pixels" check is manual today; add a canvas
  pixel-sampling assertion using a headless-Chromium test runner, since
  `OffscreenCanvas` isn't available under plain Node).
- **Privacy leakage rate / task success rate metrics** (spec section 15)
  aren't instrumented — `background.js#log` gives you a redacted event
  stream to build a harness on top of, but nothing aggregates it yet.

## 7. Benchmark plan (4 GB / 8 GB / 16 GB RAM)

Use `chrome://tracing` + `performance.memory` (or the Task Manager) plus
timestamps already emitted via `log()` in `background.js` to capture, per
tier:

| Metric | How |
|---|---|
| Model load time | `t(LOAD_MODEL response) - t(request)` |
| First inference latency | first `RUN_PERCEPTION` round-trip |
| Steady-state inference latency | mean of subsequent `RUN_PERCEPTION` round-trips |
| Peak RAM | `chrome://extensions` → service worker memory, or OS-level sampling of the extension's renderer processes during a run |
| WebGPU memory | `chrome://gpu` counters, or `navigator.gpu` adapter info where exposed |
| Screenshot processing time | wrap `chrome.tabs.captureVisibleTab` + `sanitizeScreenshot` calls |
| Privacy detection latency | wrap `runPrivacyGate` |
| End-to-end task time | `t(task_complete log) - t(START_TASK)` |
| Task success rate | manual/automated pass-fail over a fixed task suite (extend `tests/` with scenario fixtures) |
| Privacy leakage rate | assert (in tests, against a mocked `fetch`) that zero remote request bodies match any regex in `shared/detectors.js` |

Suggested device/tier matrix to actually run this on:
- **4 GB RAM**, no WebGPU → force `LOCAL_VLM_DEVICE=wasm`,
  `LOCAL_VLM_DTYPE=q4`, and prefer a smaller model id; expect DOM+regex
  detection to carry more of the privacy-gate load than the VLM here.
- **8 GB RAM**, WebGPU available → `auto`/`q8`, mid-size model.
- **16 GB RAM**, WebGPU available → `auto`/`fp16`, largest supported
  model, to establish the accuracy ceiling the smaller tiers are traded
  off against.

Run the same fixed task suite on all three and record the metrics table
above per tier before deciding whether adaptive tiering (spec section 14)
is worth building — per the spec's own guidance, don't build it
speculatively.

## 8. Explicit note on incompleteness

This is a working, tested scaffold of every seam the spec calls out
(local VLM hook, DOM hybrid perception, privacy gate with multi-layer
detection, sanitization, local-only credential/file resolution, model
routing, change-detection caching, and an action executor reusing
Magnitude's action vocabulary) — but it is **not** a drop-in replacement
for a fully hardened production agent. Section 6 above is the concrete
punch list. Don't treat this README as a claim that the demo scenario in
spec section 17 has been run end-to-end against a real form; the pieces
are wired together and unit-tested, but I have not driven a live
Aadhaar-style form through Chrome in this environment.
