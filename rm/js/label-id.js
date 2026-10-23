/* label-id.js — label code identity (V3.646)
 *
 * A vendored port of LabelPrinter/web/core/ids.js @ 83cb93f. That repo is the
 * MINTING authority's own implementation; this is the READING side, and the two
 * must agree exactly or a scan resolves to the wrong tube or to nothing. Kept as
 * a mechanical ESM→IIFE conversion (RM has no build step and only the pdf-viewer
 * pages use type="module") so drift is a `diff`, not archaeology.
 *
 * WHY THE ALPHABET IS WHAT IT IS — all three constraints are load-bearing:
 *   - Crockford Base32 excludes I, L, O and U, which removes every visually
 *     ambiguous pair. The fallback path when a QR is frosted or scratched is a
 *     human squinting at a tube, so 0/O and 1/I must not both exist.
 *   - Uppercase throughout, because QR ALPHANUMERIC mode is uppercase-only and a
 *     single lowercase character silently drops the encoder into byte mode,
 *     shrinking capacity and pushing the symbol to a version that no longer fits
 *     a 111-dot strip.
 *   - A Luhn mod-32 check character so a mistyped code fails LOUDLY rather than
 *     resolving to somebody else's tube. That is the whole reason a typo is worth
 *     distinguishing from an unknown code.
 *
 * TWO SHARP EDGES this file adds over a verbatim port:
 *
 * 1. isValid() is length-agnostic and accepts a 2-character body, so roughly 1
 *    in 32 random strings passes it. It is a check-DIGIT test, not a shape test.
 *    Gate on isWellFormed() — CODE_RE first — or every stray barcode burns a
 *    Firestore read and ~3% of garbage resolves as "unknown code" instead of
 *    "that isn't one of ours".
 *
 * 2. normalize() degrades a scanned URL by taking its LAST PATH SEGMENT. That is
 *    why a URL payload must be path-style at the site root
 *    (MCGHEELAB.COM/L/MG-A7K2X) and never a query string — `?code=` would
 *    normalize to `SCAN.HTML?CODE=MG-A7K2X`. It also folds I/L/O/U inside the
 *    PREFIX, which is harmless for `MG` but would corrupt a future `BOX-` style
 *    prefix, so labels/{CODE} doc ids are always normalize(code), never a raw
 *    mint.
 *
 * Global: window.LABEL_ID
 */
(function () {
  'use strict';

  var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // 32 chars, no I L O U
  var BASE = ALPHABET.length;
  var PREFIX = 'MG';

  /* The Crockford alphabet written out rather than [A-Z0-9], so a character that
   * survived folding but still isn't legal (I, L, O, U) fails the shape test
   * instead of sailing through to a Firestore read. */
  var CODE_RE = /^MG-[0-9A-HJKMNP-TV-Z]{5}$/;

  function randomChars(n) {
    var out = [];
    var buf = new Uint32Array(n);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < n; i++) out.push(ALPHABET[buf[i] % BASE]);
    return out.join('');
  }

  /** Luhn mod-N over the Crockford alphabet. */
  function checkChar(body) {
    var factor = 2, sum = 0;
    for (var i = body.length - 1; i >= 0; i--) {
      var code = ALPHABET.indexOf(body[i]);
      if (code < 0) continue;
      var addend = factor * code;
      factor = factor === 2 ? 1 : 2;
      addend = Math.floor(addend / BASE) + (addend % BASE);
      sum += addend;
    }
    return ALPHABET[(BASE - (sum % BASE)) % BASE];
  }

  /** e.g. "MG-A7K2X" — prefix, 4 random, 1 check. */
  function mintId(prefix) {
    var body = randomChars(4);
    return (prefix || PREFIX) + '-' + body + checkChar(body);
  }

  /**
   * Normalise anything a scanner or a human might produce into the canonical
   * form. A scanned URL degrades to its last path segment; confusables fold onto
   * the character they were meant to be, so a hand-transcribed "MG-A7KZ" still
   * resolves.
   */
  function normalize(raw) {
    var s = String(raw == null ? '' : raw).trim().toUpperCase();
    if (s.indexOf('/') >= 0) {
      var parts = s.split('/').filter(Boolean);
      s = parts.length ? parts[parts.length - 1] : s;
    }
    return s.replace(/[ILO]/g, function (c) {
      return { I: '1', L: '1', O: '0' }[c];
    }).replace(/U/g, 'V');
  }

  /** Validate the check character. Accepts with or without the prefix. */
  function isValid(id) {
    var s = normalize(id);
    var body = s.indexOf('-') >= 0 ? s.split('-').pop() : s;
    if (!body || body.length < 2) return false;
    var data = body.slice(0, -1);
    return checkChar(data) === body.slice(-1);
  }

  /** Shape AND check character. THIS is the gate to use before a Firestore read. */
  function isWellFormed(code) {
    var s = normalize(code);
    return CODE_RE.test(s) && isValid(s);
  }

  /** Batch of unique codes; collisions against `taken` are rejected and retried. */
  function mintMany(count, taken, prefix) {
    taken = taken || new Set();
    var out = [];
    var guard = 0;
    while (out.length < count && guard < count * 50) {
      guard++;
      var id = mintId(prefix);
      if (taken.has(id) || out.indexOf(id) >= 0) continue;
      out.push(id);
    }
    return out;
  }

  window.LABEL_ID = {
    PREFIX: PREFIX,
    ALPHABET: ALPHABET,
    CODE_RE: CODE_RE,
    normalize: normalize,
    isValid: isValid,
    isWellFormed: isWellFormed,
    mintId: mintId,
    mintMany: mintMany,
  };
})();
