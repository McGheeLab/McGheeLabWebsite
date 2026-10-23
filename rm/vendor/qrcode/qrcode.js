/* qrcode.js — RM's copy of LabelPrinter/web/core/qrcode.js (V3.834).
 *
 * A mechanical ESM→IIFE port of the label printer's own QR encoder (versions
 * 1–4, ECC L/M/Q/H), kept byte-identical in its logic so a QR previewed on the
 * lab site is the SAME symbol the printer lays down — scripts/tests/
 * inventory-labels.test.mjs imports both and compares the matrices. Only the
 * wrapper and toSvg() are ours. Global: window.QRCODE; node: module.exports.
 * ───────────────────────────────────────────────────────────────────────── */
(function (root) {
'use strict';

/**
 * Minimal QR encoder, versions 1-4, ECC levels L/M/Q/H.
 *
 * ---------------------------------------------------------------------------
 * Why encode here instead of using the printer's ^BQ
 * ---------------------------------------------------------------------------
 * ^BQ makes the PRINTER choose the QR version from the payload, ECC level and
 * encoding mode. If its choice differs from ours by even one version, the
 * printed symbol is 4 modules bigger than the preview - and on a 111-dot strip
 * that is the difference between fitting and colliding with a perforation. So
 * we encode the matrix here, draw THAT in the preview, and emit THAT same
 * bitmap as ^GF. Preview and print are then bit-identical by construction.
 *
 * ---------------------------------------------------------------------------
 * Why versions 1-4 is enough
 * ---------------------------------------------------------------------------
 * A strip's safe height is 101 dots. At magnification 3 the symbol is
 * modules*3 dots, plus a 4-module quiet zone the spec requires:
 *
 *     v1 (21) -> 63 + 24 = 87 dots     fits
 *     v2 (25) -> 75 + 24 = 99 dots     fits
 *     v3 (29) -> 87 + 24 = 111 dots    does not fit
 *
 * So the payload must stay inside v2, which is ~38 characters in alphanumeric
 * mode. That is the real reason tube IDs are short and uppercase: QR
 * alphanumeric mode is uppercase-only, and one lowercase character silently
 * drops the encoder to byte mode, shrinking capacity and pushing the symbol to
 * v3 - which no longer fits.
 */

// ---------------------------------------------------------------------------
// GF(256) arithmetic, primitive polynomial 0x11D
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon generator polynomial of the given degree. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, eccLen) {
  const gen = rsGenerator(eccLen);
  const res = new Uint8Array(eccLen);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[eccLen - 1] = 0;
    for (let i = 0; i < eccLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Version / ECC tables (v1-v4 only)
// ---------------------------------------------------------------------------

const TOTAL_CODEWORDS = { 1: 26, 2: 44, 3: 70, 4: 100 };

// [ numBlocks, dataCodewordsPerBlock, eccCodewordsPerBlock ]
const BLOCKS = {
  1: { L: [1, 19, 7], M: [1, 16, 10], Q: [1, 13, 13], H: [1, 9, 17] },
  2: { L: [1, 34, 10], M: [1, 28, 16], Q: [1, 22, 22], H: [1, 16, 28] },
  3: { L: [1, 55, 15], M: [1, 44, 26], Q: [2, 17, 18], H: [2, 13, 22] },
  4: { L: [1, 80, 20], M: [2, 32, 18], Q: [2, 24, 26], H: [4, 9, 16] },
};

const ALIGN_CENTERS = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26] };

const ECC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

const MAX_VERSION = 4;
const sizeOf = (version) => version * 4 + 17;

// ---------------------------------------------------------------------------
// Mode selection and data encoding
// ---------------------------------------------------------------------------

function pickMode(text) {
  if (/^[0-9]*$/.test(text)) return "numeric";
  if ([...text].every((c) => ALNUM.includes(c))) return "alphanumeric";
  return "byte";
}

class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}

function charCountBits(mode) {
  // Versions 1-9 only, which is all we support.
  return { numeric: 10, alphanumeric: 9, byte: 8 }[mode];
}

function encodeSegment(buf, text, mode) {
  if (mode === "numeric") {
    buf.put(0b0001, 4);
    buf.put(text.length, charCountBits(mode));
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      buf.put(parseInt(chunk, 10), chunk.length * 3 + 1);
    }
  } else if (mode === "alphanumeric") {
    buf.put(0b0010, 4);
    buf.put(text.length, charCountBits(mode));
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) {
        buf.put(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      } else {
        buf.put(ALNUM.indexOf(text[i]), 6);
      }
    }
  } else {
    const bytes = new TextEncoder().encode(text);
    buf.put(0b0100, 4);
    buf.put(bytes.length, charCountBits(mode));
    for (const b of bytes) buf.put(b, 8);
  }
}

/** Smallest version that holds `text` at `ecc`, or null if it needs > v4. */
function pickVersion(text, ecc = "M") {
  const mode = pickMode(text);
  for (let v = 1; v <= MAX_VERSION; v++) {
    const [blocks, dataPer] = BLOCKS[v][ecc];
    const capacityBits = blocks * dataPer * 8;
    const probe = new BitBuffer();
    encodeSegment(probe, text, mode);
    if (probe.length + 4 <= capacityBits) return v;
  }
  return null;
}

function buildCodewords(text, version, ecc) {
  const mode = pickMode(text);
  const [numBlocks, dataPer, eccPer] = BLOCKS[version][ecc];
  const totalData = numBlocks * dataPer;

  const buf = new BitBuffer();
  encodeSegment(buf, text, mode);

  // Terminator, then pad to a byte boundary.
  const capacity = totalData * 8;
  buf.put(0, Math.min(4, capacity - buf.length));
  while (buf.length % 8 !== 0) buf.bits.push(0);

  const bytes = Array.from(buf.toBytes());
  const PAD = [0xec, 0x11];
  let p = 0;
  while (bytes.length < totalData) bytes.push(PAD[p++ % 2]);

  // Split into blocks, compute ECC per block, then interleave both.
  const dataBlocks = [];
  const eccBlocks = [];
  for (let b = 0; b < numBlocks; b++) {
    const block = bytes.slice(b * dataPer, (b + 1) * dataPer);
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, eccPer));
  }

  const out = [];
  for (let i = 0; i < dataPer; i++) for (const blk of dataBlocks) out.push(blk[i]);
  for (let i = 0; i < eccPer; i++) for (const blk of eccBlocks) out.push(blk[i]);

  if (out.length !== TOTAL_CODEWORDS[version]) {
    throw new Error(`codeword count ${out.length} != ${TOTAL_CODEWORDS[version]} for v${version}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

function blankMatrix(size) {
  return {
    m: Array.from({ length: size }, () => new Int8Array(size).fill(-1)), // -1 = free
    size,
  };
}

function placeFinder(g, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= g.size || cc < 0 || cc >= g.size) continue;
      const inRing =
        (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
        (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      g.m[rr][cc] = inRing || inCore ? 1 : 0;
    }
  }
}

function placeFunctionPatterns(g, version) {
  const n = g.size;
  placeFinder(g, 0, 0);
  placeFinder(g, 0, n - 7);
  placeFinder(g, n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    g.m[6][i] = bit;
    g.m[i][6] = bit;
  }

  // Alignment patterns, skipping those that would overlap a finder.
  const centers = ALIGN_CENTERS[version];
  for (const r of centers) {
    for (const c of centers) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          g.m[r + dr][c + dc] = ring === 1 ? 0 : 1;
        }
      }
    }
  }

  // Dark module, and reserve the format-info areas.
  g.m[n - 8][8] = 1;
  for (let i = 0; i < 9; i++) {
    if (g.m[8][i] === -1) g.m[8][i] = 0;
    if (g.m[i][8] === -1) g.m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (g.m[8][n - 1 - i] === -1) g.m[8][n - 1 - i] = 0;
    if (g.m[n - 1 - i][8] === -1) g.m[n - 1 - i][8] = 0;
  }
}

/** True where a module belongs to a function pattern (not data). */
function reservedMask(version) {
  const n = sizeOf(version);
  const g = blankMatrix(n);
  placeFunctionPatterns(g, version);
  return g.m.map((row) => Array.from(row, (v) => v !== -1));
}

function placeData(g, codewords, reserved) {
  const n = g.size;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const nextBit = () => {
    if (bitIndex >= totalBits) return 0;
    const bit = (codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped
    for (let step = 0; step < n; step++) {
      const row = upward ? n - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        g.m[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(matrix, reserved, maskIndex) {
  const n = matrix.length;
  const fn = MASKS[maskIndex];
  const out = matrix.map((row) => Array.from(row));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (reserved[r][c]) continue;
      if (fn(r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

function penalty(m) {
  const n = m.length;
  let score = 0;

  // Rule 1: runs of five or more identical modules.
  const runScore = (get) => {
    let s = 0;
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
    }
    return s;
  };
  score += runScore((r, c) => m[r][c]);
  score += runScore((c, r) => m[r][c]);

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns.
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, a, b) => {
    for (let k = 0; k < 11; k++) {
      const v = get(a, b + k);
      if (v !== P1[k]) return false;
    }
    return true;
  };
  const matches2 = (get, a, b) => {
    for (let k = 0; k < 11; k++) if (get(a, b + k) !== P2[k]) return false;
    return true;
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c + 10 < n; c++) {
      if (matches((a, b) => m[a][b], r, c)) score += 40;
      if (matches2((a, b) => m[a][b], r, c)) score += 40;
      if (matches((a, b) => m[b][a], r, c)) score += 40;
      if (matches2((a, b) => m[b][a], r, c)) score += 40;
    }
  }

  // Rule 4: deviation from 50% dark.
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

function formatBits(ecc, maskIndex) {
  const data = (ECC_BITS[ecc] << 3) | maskIndex;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem <<= 1;
    if (rem & 0x400) rem ^= 0x537;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * Place the 15-bit format field, twice.
 *
 * ---------------------------------------------------------------------------
 * This was TRANSPOSED, and it made every symbol unreadable
 * ---------------------------------------------------------------------------
 * `m` is indexed m[row][col]. The spec (ISO/IEC 18004 fig. 25) runs the first
 * six bits of copy 1 DOWN COLUMN 8, and bits 9-14 ALONG ROW 8. The previous
 * version had those two axes swapped - `m[8][i]` where `m[i][8]` was meant -
 * for both copies.
 *
 * Everything else about the encoder was correct: the data codewords, the
 * Reed-Solomon parity, the interleave, the module placement and the mask are
 * all bit-identical to a reference encoder once you unmask them. But the format
 * field is where the symbol DECLARES which mask it used, so a transposed field
 * told every scanner to unmask with the wrong pattern - and a QR unmasked with
 * the wrong pattern is noise. The symbol looked perfect: correct finders,
 * correct timing, correct size, plausible module density.
 *
 * Nothing in the test suite could see it. `check_qr.mjs` validates the data and
 * ECC codewords against the published HELLO WORLD vector and asserts the finder
 * rings are present - both of which passed - but it never decoded a whole
 * symbol, so the one thing that was broken was the one thing nothing checked.
 * `check_qr.mjs` now round-trips through a real decoder.
 */
function placeFormat(m, ecc, maskIndex) {
  const n = m.length;
  const bits = formatBits(ecc, maskIndex);
  const bit = (i) => (bits >>> i) & 1;

  // Copy 1: bits 0-5 down column 8, then the corner, then bits 9-14 along row 8.
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  m[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i);

  // Copy 2: bits 0-7 along row 8 from the right edge, bits 8-14 up column 8
  // from the bottom edge.
  for (let i = 0; i <= 7; i++) m[8][n - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) m[n - 15 + i][8] = bit(i);

  // Always dark, at (row 4*version+9, col 8). Symmetric, so this one position
  // was right even while everything around it was transposed.
  m[n - 8][8] = 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * encode(text, { ecc }) -> { size, version, ecc, mode, modules }
 * `modules` is a size x size array of 0/1.
 *
 * Throws when the payload needs more than version 4, which is the point at
 * which a symbol can no longer fit a 111-dot strip.
 */
function encode(text, { ecc = "M" } = {}) {
  const version = pickVersion(text, ecc);
  if (!version) {
    throw new Error(
      `"${text.slice(0, 24)}…" needs a QR larger than version ${MAX_VERSION}, ` +
      `which will not fit a 111-dot strip. Shorten the payload.`
    );
  }

  const codewords = buildCodewords(text, version, ecc);
  const reserved = reservedMask(version);
  const g = blankMatrix(sizeOf(version));
  placeFunctionPatterns(g, version);
  placeData(g, codewords, reserved);

  const base = g.m.map((row) => Array.from(row, (v) => (v === -1 ? 0 : v)));

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, reserved, mask);
    placeFormat(candidate, ecc, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, mask, modules: candidate };
  }

  return {
    size: sizeOf(version),
    version,
    ecc,
    mode: pickMode(text),
    mask: best.mask,
    modules: best.modules,
  };
}

/**
 * Render a module matrix to a 1-bit bitmap at `mag` dots per module, ready for
 * both the canvas preview and a ^GF field. Row-major, MSB first, rows padded
 * to whole bytes - exactly the layout ZPL's ^GFA expects.
 */
function toBitmap(modules, mag = 3) {
  const n = modules.length;
  const w = n * mag;
  const h = n * mag;
  const bytesPerRow = Math.ceil(w / 8);
  const bits = new Uint8Array(bytesPerRow * h);

  for (let r = 0; r < h; r++) {
    const srcRow = modules[Math.floor(r / mag)];
    for (let c = 0; c < w; c++) {
      if (srcRow[Math.floor(c / mag)]) {
        bits[r * bytesPerRow + (c >> 3)] |= 0x80 >> (c & 7);
      }
    }
  }
  return { bits, w, h, bytesPerRow, totalBytes: bits.length };
}

/** Uppercase hex for ^GFA. */
function toHex(bits) {
  let s = "";
  for (const b of bits) s += b.toString(16).padStart(2, "0").toUpperCase();
  return s;
}

/** Exposed for known-answer tests; not part of the app's normal surface. */
const __test = { buildCodewords, rsEncode, reservedMask, formatBits };


/** Our addition: the module matrix as an SVG string (crisp, scalable, no canvas). */
function toSvg(modules, opts) {
  opts = opts || {};
  const n = modules.length;
  const m = opts.margin == null ? 4 : opts.margin, s = opts.scale || 4;
  const size = (n + 2 * m) * s;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modules[y][x]) d += 'M' + ((x + m) * s) + ' ' + ((y + m) * s) + 'h' + s + 'v' + s + 'h-' + s + 'z';
  const w = opts.width || size;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + w + '" height="' + w + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
    '<rect width="100%" height="100%" fill="' + (opts.light || '#fff') + '"/><path d="' + d + '" fill="' + (opts.dark || '#000') + '"/></svg>';
}

const QRCODE = { encode, pickMode, pickVersion, sizeOf, toBitmap, toHex, toSvg, MAX_VERSION, __test };
if (typeof module !== 'undefined' && module.exports) module.exports = QRCODE;
if (root) root.QRCODE = QRCODE;
})(typeof window !== 'undefined' ? window : null);
