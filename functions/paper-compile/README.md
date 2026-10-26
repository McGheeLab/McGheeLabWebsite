# paper-compile — Cloud Run service for LaTeX → PDF (V3.231)

Compiles a paper bundle produced by `rm/js/paper-export.js` to PDF
using [Tectonic](https://tectonic-typesetting.github.io/) inside a
Cloud Run container.

**This service is private.** The browser never calls it directly —
it's invoked by the public Firebase Function
[`paperCompile`](../paper-compile-proxy.js), which does Firebase ID
token + lab-role verification and forwards the request with a GCP
identity token. See the V3.231 deploy postmortem in
[`../../CodeLog/Updates/CHANGELOG.md`](../../CodeLog/Updates/CHANGELOG.md)
for why we ended up with the proxy architecture instead of public
Cloud Run access.

Read by the Paper Export Workspace at
[`/rm/pages/paper-export.html`](../../rm/pages/paper-export.html).

## Architecture

```
browser
  │  POST  Authorization: Bearer <Firebase ID token>
  ▼
Firebase Function paperCompile (../paper-compile-proxy.js, public)
  │  verifies Firebase token + lab-member role
  │  mints GCP identity token from metadata server
  │  POST  Authorization: Bearer <GCP ID token>
  │       X-User-Uid:  <verified uid>
  │       X-User-Role: <verified role>
  ▼
Cloud Run paper-compile (this service, private)
  │  Cloud Run IAM gates by SA (only Functions runtime SA may invoke)
  │  Express handler trusts X-User-* headers (proxy already verified)
  │  runs Tectonic, uploads PDF to Storage, signs URL
  ▼
back to function → back to browser
```

## Engine

Why Cloud Run + Tectonic, not Cloud Functions + TeX Live:

- Cloud Functions Gen 2 deploys *are* Cloud Run under the hood, but
  Firebase Functions can't ship a custom `Dockerfile` cleanly. Tectonic
  is a native binary, not an npm package.
- Tectonic (~50 MB compressed) vs full TeX Live (~2 GB image). Faster
  cold start, smaller image, and Tectonic auto-fetches CTAN packages
  on demand the first time it sees them.

## Deploy

```bash
cd functions/paper-compile
gcloud run deploy paper-compile \
  --source . \
  --region us-central1 \
  --port=8080 \
  --no-allow-unauthenticated \
  --memory 1Gi \
  --timeout 120 \
  --max-instances 3 \
  --set-env-vars FIREBASE_STORAGE_BUCKET=mcgheelab-f56cc.firebasestorage.app
```

The build takes about five minutes longer than it used to (V3.916): it
fills Tectonic's package cache from `warmup/` (see below).

Important:

- **`--no-allow-unauthenticated`** keeps the service private. Only
  invokable by service accounts that have `roles/run.invoker` on it.
- **`FIREBASE_STORAGE_BUCKET`** must be the project's actual default
  Storage bucket. For mcgheelab-f56cc that's
  `mcgheelab-f56cc.firebasestorage.app` (the post-October-2024
  Firebase naming — *not* the legacy `*.appspot.com` form, which
  returns "bucket does not exist" 404 on upload).

After the first deploy, grant the Firebase Functions runtime SA the
invoker role (one-time):

```bash
gcloud run services add-iam-policy-binding paper-compile \
  --region=us-central1 \
  --member=serviceAccount:mcgheelab-f56cc@appspot.gserviceaccount.com \
  --role=roles/run.invoker
```

The compute SA (`665438582202-compute@developer.gserviceaccount.com`)
needs `roles/datastore.user` + `roles/storage.objectAdmin` at the
project level, and `roles/iam.serviceAccountTokenCreator` on itself
(for signed-URL minting). These were granted during the V3.231 deploy
session and don't need to be re-run.

## API

`POST /` — invoked by the `paperCompile` Firebase Function, not by
browsers. Required headers:

- `Authorization: Bearer <gcp-identity-token>` — Cloud Run IAM check
- `X-User-Uid: <uid>` — verified by the proxy
- `X-User-Role: <role>` — verified by the proxy; rejected if `guest`
- `Content-Type: application/json`

Body:

```json
{
  "paperId":   "your-paper-slug",
  "templateId":"mebp-journal",
  "addons":    ["lineno","microtype"],
  "files":     [{ "relpath": "main.tex", "content": "..." }, ...]
}
```

Response (200):

```json
{
  "pdfUrl":    "https://storage.googleapis.com/... (1h signed URL)",
  "log":       "tectonic stdout + stderr",
  "compileId": "8 hex chars",
  "warnings":  []
}
```

`GET /healthz` → `ok`. Bypasses the proxy headers (it's a probe), so
useful when testing via `gcloud run services proxy` directly.

## Phase 1 limitations

- **Figure files are not fetched.** The .tex bundle references figures
  via `\includegraphics{figures/<basename>}`, but the server doesn't
  download them from Firebase Storage yet. Phase 1.1 will add that
  step: parse `\includegraphics{}` from the bundle, fetch from
  `paper-figures/{paperId}/*` via Admin SDK, drop into `figures/`
  before invoking Tectonic.
- **6-pass rerun limit.** Tectonic's default rerun count caps at 6;
  papers with complex `\ref{}`/`\cref{}` chains may not converge.
  Bump via `--reruns N` in `runTectonic` args if needed.
- **No shell-escape.** Tectonic supports `-Z shell-escape` for
  `minted` and friends, but the curated add-on registry in Phase 1
  doesn't include any add-ons that need it. Flip when needed.
- **No retention policy.** Compiled PDFs accumulate at
  `paperExports/{paperId}/compiles/`. Add a scheduled cleanup
  function once retention becomes a concern (Phase 2 plan).

## Warm cache (V3.916)

A Cloud Run instance used to start with an empty Tectonic cache and fetch
every package and font on its first compile — 47 s for a journal look in
production, where most compiles after a quiet spell land on a fresh instance.
The image now ships the cache full:

- `warmup/tex-files.txt` — every bundle file a real compile has needed
  (names only). The build fetches each with `tectonic -X bundle cat`.
- `warmup/<template>[-submission]/` — one synthetic paper (invented text, a
  generated figure) as the Export page sends it for each template and page
  look; the build compiles each once, which also writes the format file.

Both are written by `python3 scripts/paper-lab/warmup.py` (Paper Lab
running). Re-run it after adding a template or a package to a journal look,
then redeploy. Measured on this machine: a real paper 38 s from an empty
cache, 2.8 s from the warm one; after the build step every corpus paper and
the NSF proposal compile with `--only-cached`. Anything a future paper needs
that is not in the cache is still fetched on demand.

