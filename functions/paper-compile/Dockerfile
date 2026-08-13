# Paper Compile service — Tectonic-backed LaTeX → PDF (V3.231)
#
# Built as a Cloud Run service (not a Firebase Function) so we can ship
# a single Tectonic binary in the image instead of bundling TeX Live.
# Tectonic is self-contained (~50 MB compressed) and fetches missing
# packages from CTAN on demand the first time it sees them.
#
# Build + deploy:
#   cd functions/paper-compile
#   gcloud run deploy paper-compile \
#     --source . \
#     --region us-central1 \
#     --allow-unauthenticated=false \
#     --memory 1Gi \
#     --timeout 120 \
#     --max-instances 3
#
# (timeout raised 90 → 120 with the latexdiff update: a diff request runs
#  latexdiff + a SECOND tectonic pass on diff.tex.)
#
# Once deployed, copy the service URL into rm/js/paper-export.js
# (PAPER_COMPILE_URL constant) and redeploy the website.

FROM node:20-bookworm-slim

# Tectonic runtime deps. ca-certificates lets it fetch CTAN over HTTPS.
# biber is needed for natbib-style bibliographies (Tectonic falls back
# to bibtex automatically; biber is the modern default for many journal
# styles).
# latexdiff (a Perl script; perl-base is already in the slim image) powers
# the marked-up revision PDFs — --no-install-recommends is CRITICAL here,
# it stops latexdiff's Recommends from dragging in a full TeX Live
# (Tectonic stays the only engine; image cost ≈ 5-10 MB).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils biber chktex latexdiff \
    && rm -rf /var/lib/apt/lists/* \
    && latexdiff --version

# Pin Tectonic. Using the official static-glibc binary keeps the image
# small (no need for the full Rust toolchain at build time).
ARG TECTONIC_VERSION=0.15.0
RUN curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin tectonic \
    && chmod +x /usr/local/bin/tectonic \
    && tectonic --version

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
