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
| **Final outgoing payload leakage scanner** | `shared/leakScanner.js` | 7, 15 |
| **Fail-closed privacy state machine** | `shared/privacyState.js` | 14 |
| **Local OCR interface + fail-closed policy** | `shared/ocr.js` | 5 |
| **Sensitive-document / PAN-card detector** | `shared/documentDetector.js` | 6 (critical PAN req.) |
| **Local CV detectors (QR/barcode/face/signature)** | `shared/visualDetectors.js` | 6 |
| **DOM/accessibility sanitizer** | `shared/domSanitizer.js` | 6 |
| **Action-aware retry + verification** | `shared/actionSafety.js` | 11, 12 |
| Action schema + local-only actions | `shared/actionSchema.js` | 9, 10, 12 |
| Credential vault encryption (AES-GCM + PBKDF2) | `shared/crypto.js` | 10 |
| Remote reasoning (sanitized-only, fail-closed) | `background/remoteClient.js` | 11, 15 |
| Routing policy + change-detection cache | `background/router.js` | 13, 14, 15 |
| Orchestrator / action executor | `background/background.js` | 2, 9, 12, 17 |
| Config + credential vault UI | `options/` | 3, 9 |
| Task control UI | `popup/` | — |
| Tests | `tests/` | 16 |

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
npm test                # runs every tests/*.test.js via node --test
node --test tests/privacy.test.js        # detectors + gate + schema
node --test tests/leakScanner.test.js    # final outgoing payload scanner
node --test tests/documentDetector.test.js # PAN / sensitive-document detection
node --test tests/piiBroadening.test.js    # broad PII + document categories
node --test tests/visualDetectors.test.js  # QR/barcode/face/signature CV
node --test tests/domSanitizer.test.js   # DOM/accessibility sanitization
node --test tests/actionSafety.test.js   # retry classification + verification
node --test tests/crypto.test.js         # AES-GCM vault round-trip / fail-safe
node --test tests/e2ePayload.test.js     # mock-server payload-leak checks
node --test tests/e2eBrowser.test.js     # headless-Chromium redaction + leak test
node --test tests/e2eVisual.test.js      # browser-rendered CV detection
```

Covers (among others): Aadhaar/PAN/email/phone/password/credit-card/address/IFSC
detection with and without context, DOM-only-adds-sensitivity, fail-closed
uncertain findings, `local:fill_credential` forbidding raw values, the **final
payload leakage scanner** blocking PAN/email/phone/API-key/base64 leaks, **PAN
card → full-region redaction** and **general document classification**
(passport/voter/employee/college ID, bank statement, cheque, tax, salary,
medical, legal, confidential) with neutral placeholders, local **CV detectors**
(QR/barcode/face/signature) over rendered pixels, sanitized DOM,
action-aware retry, and AES-GCM vault encryption.

To manually verify end-to-end: open `chrome://extensions` → this
extension → **Inspect views: service worker**, run a task against a form
containing an Aadhaar/password field, and confirm in the Network tab that the
request to `REMOTE_ENDPOINT` contains only `sanitizedContext` + a redacted
screenshot — the outbound request is aborted (fail-closed) by
`shared/leakScanner.js` if any raw value is present.

## 6. Remaining limitations / production gaps

- **Local OCR is a pluggable seam, not a bundled engine.** The
  document-detection pipeline (`shared/documentDetector.js`) accepts
  `ocrText` from any local OCR provider; the pixel-OCR step itself (e.g.
  Tesseract.js / TrOCR) is not vendored here, so OCR text for documents relies
  on the local VLM/OCR layer when present. No image ever leaves the device.
- **Face/QR/barcode/signature detectors are heuristic local CV** (skin-tone,
  finder-pattern, stripe-density, ink-density) in `shared/visualDetectors.js` —
  real and fail-closed, but lower precision than a dedicated model (BlazeFace,
  ZXing); they are additive, not replacements for OCR/document models.
- **`planLocally` is a minimal heuristic** — it only handles "fill a known
  sensitive field from the vault". A genuinely useful local-only mode needs a
  small action-planning model or larger rule library.
- **`mouse:scroll`** currently scrolls the target into view rather than
  dispatching true CDP wheel deltas.
- **Model-specific VLM prompt/output adapters** are not tuned per model.
- WebGPU availability, low-end device tiering, and per-tier benchmark data
  (section 7 below) have not been executed in this environment.

Known artefacts & compatibility notes:
- `ort-webgpu-esm.js` (root) is a vendored **ONNX Runtime WebGPU ESM bundle**
  intended for an optional ONNX-based local VLM path. It is **not currently
  wired into any code**; it is kept for the future ONNX backend. Fall back on
  the transformers.js path (`offscreen/vendor/transformers.web.min.js`), which
  is the active local-VLM runtime.
- **Firefox** is not yet supported: Firefox MV3 lacks `chrome.offscreen`
  (used for the local VLM + screenshot CV redaction); `chrome.debugger` and
  `captureVisibleTab` differ subtly. The DOM/detector/sanitizer/leak-scanner
  layer is browser-agnostic, but the offscreen/WebGPU path is Chrome-only for
  now.

The deterministically testable security boundary (detection, redaction,
sanitization, leakage scan, encryption, retry/verification) is implemented and
covered by `tests/`. The local VLM inference path is wired but its real models
must be loaded on a WebGPU/WASM-capable browser as described in section 3–4.

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

## 8. Explicit note on completeness

The security boundary is implemented and covered by an automated test suite
(58 tests, including a headless-Chromium end-to-end run that loads a
synthetic PAN-card form, redacts the card region pixel-for-pixel, and proves
the assembled payload is leak-free). The credentials vault is encrypted with
AES-GCM (key derived via PBKDF2). The retry loop is action-aware. The outbound
payload is scanned and fails closed before every network request.

What has **not** been verified in this environment is real local VLM model
inference (no WebGPU model weights were downloaded/executed here) and real
local OCR — the interfaces and fallbacks for those are wired in, but they must
be exercised on WebGPU/WASM hardware per sections 3–4 before claiming a live
demonstration. Do not treat this README as a claim that a specific remote VLM
(scoring 25% visual accuracy etc.) has been benchmarked; section 7 remains a
benchmark plan to execute on real hardware.
