/* paper-compile Cloud Run service — V3.231
 *
 * Accepts a POST from rm/js/paper-export.js carrying:
 *   {
 *     paperId,
 *     templateId,
 *     addons: [...],
 *     files: [{ relpath, content }, ...]   // .tex + .bib bundle
 *   }
 *
 * Verifies the caller's Firebase ID token (must be a lab member —
 * mirrors the firestore.rules `isLabMember()` check), writes the
 * bundle to a /tmp working dir, fetches any figure files referenced
 * by storage_path from Firebase Storage, runs Tectonic, uploads the
 * resulting PDF + log to Storage at
 *   paperExports/{paperId}/compiles/{compileId}.pdf
 * and writes a Firestore record at
 *   paperExports/{paperId}/compiles/{compileId}
 * before returning a short-lived signed URL.
 *
 * This is the Phase 1 scaffold — the figure-fetching step is stubbed
 * to "best effort" and the response shape mirrors what paper-export.js
 * already expects ({ pdfUrl, log, compileId, warnings }). Wire your
 * GCP project + Firebase Admin credentials via the runtime service
 * account (no JSON key file needed on Cloud Run).
 */

const express = require('express');
const admin = require('firebase-admin');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

admin.initializeApp({
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
});

const app = express();
app.use(express.json({ limit: '50mb' }));

/* ── Auth middleware ──
 *
 * V3.231 update: the service is now PRIVATE — only the `paperCompile`
 * Firebase Function (mcgheelab-f56cc@appspot.gserviceaccount.com) can
 * invoke it, gated by Cloud Run IAM's `roles/run.invoker`. That
 * function has already verified the user's Firebase ID token and
 * mirrored `isLabMember()` before forwarding. We therefore TRUST the
 * `X-User-Uid` + `X-User-Role` headers it sets; Cloud Run's IAM check
 * is the actual security boundary.
 *
 * (Legacy: an earlier version of this file verified a Firebase token
 * directly via admin.auth().verifyIdToken. That path is dropped now
 * that the service isn't publicly reachable.)
 */
async function verifyToken(req, res, next) {
  const uid  = req.get('X-User-Uid')  || '';
  const role = req.get('X-User-Role') || '';
  if (!uid)            return res.status(401).json({ error: 'Missing X-User-Uid header.' });
  if (!role)           return res.status(403).json({ error: 'Missing X-User-Role header.' });
  if (role === 'guest') return res.status(403).json({ error: 'Lab membership required.' });
  req.uid  = uid;
  req.role = role;
  next();
}

/* ── Compile route ── */

app.post('/', verifyToken, async (req, res) => {
  const { paperId, files, templateId, addons } = req.body || {};
  if (!paperId || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'paperId and non-empty files[] required.' });
  }
  if (!/^[\w-]{1,128}$/.test(paperId)) {
    return res.status(400).json({ error: 'Invalid paperId.' });
  }

  const compileId = crypto.randomBytes(8).toString('hex');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'paper-compile-' + compileId + '-'));

  /* V3.232 — bundle hash for client-side staleness detection. Must match
   * the client's hash in rm/js/paper-export.js (_hashBundle): sha256 of
   * every file's `<relpath>\n<content>` joined by `\n---FILE---\n`,
   * sorted by relpath. */
  const bundleHash = (() => {
    const parts = files
      .map(f => (f.relpath || '') + '\n' + (f.content || ''))
      .sort()
      .join('\n---FILE---\n');
    return crypto.createHash('sha256').update(parts).digest('hex');
  })();

  try {
    /* Write the bundle. Path-traversal guard: every relpath must
     * normalize back inside the work dir. */
    for (const f of files) {
      if (typeof f.relpath !== 'string' || typeof f.content !== 'string') {
        return res.status(400).json({ error: 'Each file needs relpath + content strings.' });
      }
      const dst = path.resolve(work, f.relpath);
      if (!dst.startsWith(work + path.sep)) {
        return res.status(400).json({ error: 'Path traversal in relpath: ' + f.relpath });
      }
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.writeFile(dst, f.content, 'utf8');
    }

    /* TODO Phase 1.1 — fetch figures from Firebase Storage based on
     * \includegraphics{figures/<basename>} patterns. For Phase 1 the
     * compile may produce a PDF with missing-figure boxes; that's an
     * acceptable failure mode for the first deploy. */

    const mainFile = files.find(f => /(^|\/)main\.tex$/.test(f.relpath))
      ? 'main.tex'
      : files[0].relpath;

    const { code, stdout, stderr } = await runTectonic(work, mainFile);
    const log = (stdout || '') + (stderr ? '\n--- stderr ---\n' + stderr : '');
    const pdfPath = path.join(work, mainFile.replace(/\.tex$/i, '.pdf'));
    if (code !== 0 || !fs.existsSync(pdfPath)) {
      return res.status(500).json({
        error: 'Tectonic failed (exit code ' + code + ').',
        log,
        compileId,
      });
    }

    /* Upload PDF. */
    const bucket = admin.storage().bucket();
    const dest = `paperExports/${paperId}/compiles/${compileId}.pdf`;
    await bucket.upload(pdfPath, {
      destination: dest,
      contentType: 'application/pdf',
      metadata: { metadata: { compiledBy: req.uid, paperId, compileId, templateId: templateId || '' } },
    });
    const [url] = await bucket.file(dest).getSignedUrl({
      action: 'read',
      expires: Date.now() + 60 * 60 * 1000,    // 1 hour
    });

    /* Record the compile in Firestore — admin-write only per rules. */
    await admin.firestore()
      .collection('paperExports').doc(paperId)
      .collection('compiles').doc(compileId)
      .set({
        compileId,
        paperId,
        templateId: templateId || '',
        addons: Array.isArray(addons) ? addons : [],
        triggeredBy: req.uid,
        triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
        pdfStoragePath: dest,
        bundleHash,                    // V3.232 — for client-side staleness detection
        logTail: log.slice(-4000),     // keep doc small; full log lives in the response
        ok: true,
      });

    res.json({ pdfUrl: url, log, compileId, warnings: [] });
  } catch (err) {
    console.error('[compile] failed:', err);
    res.status(500).json({ error: err.message, compileId });
  } finally {
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/healthz', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 8080;
/* Bind to 0.0.0.0 explicitly. Without this, Node defaults to IPv6 wildcard
 * '::' which Cloud Run's IPv4 ingress proxy can't reach — the TCP startup
 * probe succeeds via loopback but real traffic from the frontend 404s with
 * Google's edge "robot" page before ever hitting Express. */
app.listen(PORT, '0.0.0.0', () => console.log('paper-compile listening on :' + PORT));

/* ── Tectonic runner ── */

function runTectonic(cwd, mainFile) {
  return new Promise((resolve) => {
    const args = ['-X', 'compile', '--keep-intermediates', '--keep-logs', mainFile];
    const proc = spawn('tectonic', args, { cwd });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => resolve({ code: -1, stdout: out, stderr: err + '\n' + e.message }));
    proc.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}
