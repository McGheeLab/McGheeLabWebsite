/* ================================================================
   equationOcr — snip image → LaTeX via a vision model (V3.461).
   ================================================================
   The reader's equation-capture modal (rm/js/equation-capture.js)
   snips the selected region of the rendered PDF page as a small JPEG
   data-URI. This function transcribes that image to LaTeX so the user
   verifies instead of typing:

     browser
       │  POST { image: dataURI }
       │  Authorization: Bearer <Firebase ID token>
       ▼
     equationOcr (this function — verifies token + lab-member role,
       │           same gate as paperCompile)
       │  Anthropic Messages API (vision) — transcription-only prompt
       ▼
     { latex } back to the browser (or { error } / UNREADABLE → 422)

   GET is a health probe: the client shows its ✨ Auto-read button only
   after this answers 200, so the browser UI ships safely BEFORE the
   function is deployed.

   One-time setup + deploy (Alex):
     firebase functions:secrets:set ANTHROPIC_API_KEY
     firebase deploy --only functions:equationOcr

   Cost note: one capture ≈ a single small image + ~100 output tokens —
   fractions of a cent on the model below.
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/* Vision model for transcription. Sonnet reads dense math reliably;
 * swap for 'claude-haiku-4-5' if cost ever matters more than the
 * occasional mangled superscript. */
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const MAX_IMAGE_CHARS = 2 * 1024 * 1024;   // ~1.5 MB binary — snips are ~40-80 KB

const SYSTEM_PROMPT = [
  'You transcribe images of mathematical equations into LaTeX.',
  'Rules:',
  '- Output ONLY the LaTeX source of the equation. No explanations, no markdown code fences, no surrounding $ / $$ / \\[ delimiters.',
  '- Use standard amsmath commands: \\frac, \\sqrt, \\sum, \\prod, \\int, \\partial, \\nabla, pmatrix/bmatrix/vmatrix/cases, \\hat, \\bar, \\dot, \\ddot, \\vec, \\mathbf for bold symbols, \\mathrm for upright text like d in dx, \\text{...} for words.',
  '- Preserve every subscript, superscript, prime, accent, bracket and Greek letter exactly as printed.',
  '- For multi-line derivations use \\begin{aligned}...\\end{aligned} with \\\\ line breaks, aligning on = where natural.',
  '- Omit any printed equation number like (3) at the margin.',
  '- If the image contains no readable mathematics, output exactly: UNREADABLE',
].join('\n');

/* Strip the wrappers models sometimes add despite instructions:
 * ```latex fences, $$..$$ / $..$ / \[..\] delimiters. */
function cleanLatex(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```\s*$/, '').trim();
  const wraps = [
    [/^\$\$/, /\$\$$/],
    [/^\\\[/, /\\\]$/],
    [/^\$/, /\$$/],
  ];
  for (const [openRe, closeRe] of wraps) {
    if (openRe.test(s) && closeRe.test(s)) {
      s = s.replace(openRe, '').replace(closeRe, '').trim();
      break;
    }
  }
  return s;
}

const equationOcr = onRequest({
  cors: true,
  maxInstances: 2,
  memory: '256MiB',
  timeoutSeconds: 60,
  secrets: [ANTHROPIC_API_KEY],
}, async (req, res) => {
  if (req.method === 'GET') {
    /* Health probe — the capture modal gates its ✨ button on this. */
    res.status(200).send('equationOcr ok');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  /* Verify Firebase ID token (same gate as paperCompile). */
  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.status(401).json({ error: 'Missing Bearer token.' });
    return;
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
    return;
  }

  /* Mirror isLabMember(). */
  const userDoc = await admin.firestore().collection('users').doc(decoded.uid).get();
  const role = userDoc.exists ? (userDoc.data() || {}).role : null;
  if (!role || role === 'guest') {
    res.status(403).json({ error: 'Lab membership required.' });
    return;
  }

  /* Validate the snip. */
  const image = (req.body || {}).image;
  if (typeof image !== 'string' || image.length > MAX_IMAGE_CHARS) {
    res.status(400).json({ error: 'Expected { image: dataURI } under 1.5 MB.' });
    return;
  }
  const dm = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!dm) {
    res.status(400).json({ error: 'image must be a jpeg/png/webp base64 data URI.' });
    return;
  }

  /* Anthropic Messages API (Node 20 global fetch, no SDK dependency). */
  let apiResp;
  try {
    apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY.value(),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: dm[1], data: dm[2] } },
            { type: 'text', text: 'Transcribe this equation to LaTeX.' },
          ],
        }],
      }),
    });
  } catch (err) {
    console.error('[equationOcr] API fetch failed:', err.message);
    res.status(502).json({ error: 'Transcription service unreachable.' });
    return;
  }

  let data;
  try { data = await apiResp.json(); } catch (e) { data = null; }
  if (!apiResp.ok || !data) {
    const msg = (data && data.error && data.error.message) || ('API error ' + apiResp.status);
    console.error('[equationOcr] API error:', msg);
    res.status(502).json({ error: msg });
    return;
  }

  const raw = ((data.content || []).find((c) => c.type === 'text') || {}).text || '';
  const latex = cleanLatex(raw);
  const usage = data.usage || {};
  console.log('[equationOcr]', decoded.uid, 'model=' + MODEL,
    'in=' + (usage.input_tokens || '?'), 'out=' + (usage.output_tokens || '?'),
    'len=' + latex.length);

  if (!latex || /^UNREADABLE\b/.test(latex)) {
    res.status(422).json({ error: 'No readable equation found in the snip.' });
    return;
  }
  res.status(200).json({ latex, model: MODEL });
});

module.exports = { equationOcr };
