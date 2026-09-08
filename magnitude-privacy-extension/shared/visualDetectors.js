// shared/visualDetectors.js
//
// Local computer-vision detectors for visual privacy signals that cannot be
// captured by text/metadata regex: QR codes, barcodes, faces, and signatures.
// They operate on raw RGBA pixel data (no network, no model download) and are
// invoked on screenshot/image regions BEFORE anything leaves the device.
//
// These are heuristic, dependency-free detectors. They are the local CV layer
// the spec asks for and are additive to OCR/document classification; a
// production build should also incorporate a heavier local model (BlazeFace,
// YOLO-style doc classifier, ZXing) for higher precision, but the below
// detectors give a real fail-closed signal without any external payload.

/**
 * @typedef {{ x:number, y:number, width:number, height:number }} Bbox
 * @typedef {{ category:string, bbox:Bbox, confidence:number }} VisualFinding
 */

function luminance(data, i) {
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
}

// --- QR-code like region (finder-pattern 1:1:3:1:1 detection) ----------

function runLengthsOf(thresholded, start, stride, count) {
  const runs = [];
  let cur = null;
  for (let k = 0; k < count; k++) {
    const v = thresholded[start + k * stride];
    if (!cur || cur.value !== v) {
      cur = { value: v, length: 0 };
      runs.push(cur);
    }
    cur.length++;
  }
  return runs;
}

// A QR finder pattern scans (through its centre) as black/white/black/white/black
// with module ratio ≈ 1:1:3:1:1.
function looksLikeFinder(runs) {
  if (runs.length < 5) return false;
  for (let s = 0; s + 4 < runs.length; s++) {
    const [a, b, c, d, e] = runs.slice(s, s + 5);
    if (!(a.value === 0 && b.value === 1 && c.value === 0 && d.value === 1 && e.value === 0)) continue;
    const unit = (a.length + b.length + d.length + e.length) / 4;
    if (unit < 1) continue;
    const near = (v) => Math.abs(v - unit) <= unit * 0.8;
    if (!near(a.length) || !near(b.length) || !near(d.length) || !near(e.length)) continue;
    if (c.length >= unit * 2.2 && c.length <= unit * 4.2) return true;
  }
  return false;
}

/**
 * Detect QR-code-like regions by locating finder patterns along rows/columns.
 */
export function detectQrLikeRegions(data, width, height, { threshold = 128 } = {}) {
  const n = width * height;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = luminance(data, i * 4) < threshold ? 0 : 1;

  const hits = [];
  const check = (start, stride, count, axis) => {
    const runs = runLengthsOf(bin, start, stride, count);
    if (looksLikeFinder(runs)) {
      // locate centre of the middle (dark) run
      const midIdx = Math.floor((runs.length - 1) / 2);
      let pos = 0;
      for (let r = 0; r < runs.length; r++) {
        if (r === midIdx) { pos += runs[r].length / 2; break; }
        pos += runs[r].length;
      }
      hits.push({ axis, coord: pos });
    }
  };

  // Sample every 3rd row horizontally and every 3rd column vertically.
  for (let y = 0; y < height; y += 3) check(y * width, 1, width, 'row');
  for (let x = 0; x < width; x += 3) check(x, width, height, 'col');

  // Cluster nearby finder hits into regions.
  const regions = clusterHits(hits, width, height);
  return regions.map(r => ({ category: 'qr_code', bbox: r, confidence: 0.7 }));
}

// --- Barcode-like region (high-frequency vertical/horizontal bars) ------

/**
 * Detect 1D barcode-like regions: rows/columns with a high count of black↔white
 * transitions sustained over a contiguous band. Vertical bars → high horizontal
 * transition frequency across many rows.
 */
export function detectBarcodeLikeRegions(data, width, height, { threshold = 128, minTransitions = 8 } = {}) {
  const n = width * height;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = luminance(data, i * 4) < threshold ? 0 : 1;

  // Count horizontal transitions per row.
  const rowTransitions = new Uint16Array(height);
  for (let y = 0; y < height; y++) {
    let t = 0;
    for (let x = 1; x < width; x++) {
      if (bin[y * width + x] !== bin[y * width + x - 1]) t++;
    }
    rowTransitions[y] = t;
  }

  // Find the widest vertical band whose rows all exceed the transition count.
  let best = null;
  let y = 0;
  while (y < height) {
    if (rowTransitions[y] >= minTransitions) {
      let y2 = y;
      while (y2 < height && rowTransitions[y2] >= minTransitions) y2++;
      if (!best || y2 - y > best.height) best = { x: 0, y, width, height: y2 - y };
      y = y2;
    } else y++;
  }

  if (!best || best.height < 4) return [];
  return [{ category: 'barcode', bbox: best, confidence: 0.7 }];
}

// --- Face-like region (skin-tone heuristic) ----------------------------

function isSkin(r, g, b) {
  if (r < 60 || g < 40 || b < 20) return false;
  if (r <= g || r <= b) return false; // red must dominate (loose)
  const cb = 128 - 0.169 * r - 0.331 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.419 * g - 0.081 * b;
  return cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/**
 * Detect the largest skin-tone blob, returning a bounding box. Heuristic; a
 * dedicated face model (BlazeFace/MediaPipe) is the production-polish path.
 */
export function detectFaceLikeRegions(data, width, height, { minArea = 120 } = {}) {
  const n = width * height;
  const skin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    skin[i] = isSkin(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) ? 1 : 0;
  }

  const regions = [];
  const visited = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!skin[i] || visited[i]) continue;
    // BFS flood fill.
    const stack = [i];
    visited[i] = 1;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, area = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % width, y = (p / width) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (skin[np] && !visited[np]) { visited[np] = 1; stack.push(np); }
      }
    }
    if (area >= minArea) {
      regions.push({ area, bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } });
    }
  }

  return regions
    .sort((a, b) => b.area - a.area)
    .slice(0, 3)
    .map(r => ({ category: 'face', bbox: r.bbox, confidence: 0.6 }));
}

// --- Signature-like region (scattered ink in a horizontal band) --------

/**
 * Detect a signature-like region: a horizontally elongated band containing a
 * moderate density of thin dark strokes (not a solid block). Heuristic.
 */
export function detectSignatureLikeRegions(data, width, height, { threshold = 128, minDarkRatio = 0.01, maxDarkRatio = 0.5 } = {}) {
  const n = width * height;
  const darkPerRow = new Uint16Array(height);
  for (let y = 0; y < height; y++) {
    let c = 0;
    for (let x = 0; x < width; x++) {
      if (luminance(data, (y * width + x) * 4) < threshold) c++;
    }
    darkPerRow[y] = c;
  }

  const regions = [];
  let y = 0;
  while (y < height) {
    const ratio = darkPerRow[y] / Math.max(1, width);
    if (ratio >= minDarkRatio && ratio <= maxDarkRatio) {
      let y2 = y;
      while (y2 < height) {
        const r2 = darkPerRow[y2] / Math.max(1, width);
        if (r2 >= minDarkRatio && r2 <= maxDarkRatio) y2++; else break;
      }
      if (y2 - y >= 4) {
        // Horizontal extent of dark pixels within the band.
        let minX = Infinity, maxX = -1;
        for (let yy = y; yy < y2; yy++) {
          for (let x = 0; x < width; x++) {
            if (luminance(data, (yy * width + x) * 4) < threshold) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        if (minX !== Infinity && (maxX - minX) > width * 0.2) {
          regions.push({ category: 'signature', bbox: { x: minX, y, width: maxX - minX + 1, height: y2 - y }, confidence: 0.6 });
        }
      }
      y = y2;
    } else y++;
  }
  return regions.slice(0, 3);
}

// --- Utilities -----------------------------------------------------------

/**
 * Run all visual detectors over raw RGBA pixels and return a combined list,
 * de-duplicated by category. This is the single entry point the offscreen /
 * privacy layer calls on a screenshot before redaction.
 */
export function detectAllVisualSensitive(data, width, height) {
  const all = [
    ...detectQrLikeRegions(data, width, height),
    ...detectBarcodeLikeRegions(data, width, height),
    ...detectFaceLikeRegions(data, width, height),
    ...detectSignatureLikeRegions(data, width, height)
  ];
  return all;
}

function clusterHits(hits, width, height) {
  if (hits.length === 0) return [];
  // Group hits within a coarse radius; a QR has 3 finder patterns.
  const boxes = [];
  const used = new Set();
  for (let i = 0; i < hits.length; i++) {
    if (used.has(i)) continue;
    const group = [hits[i]];
    used.add(i);
    for (let j = i + 1; j < hits.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(hits[i].coord - hits[j].coord) < Math.max(width, height) * 0.25) {
        group.push(hits[j]); used.add(j);
      }
    }
    if (group.length >= 2) {
      const coords = group.map(g => g.coord);
      const min = Math.min(...coords);
      const max = Math.max(...coords);
      const isRow = group[0].axis === 'row';
      boxes.push(isRow
        ? { x: min, y: 0, width: max - min + 1, height }
        : { x: 0, y: min, width, height: max - min + 1 });
    }
  }
  return boxes;
}