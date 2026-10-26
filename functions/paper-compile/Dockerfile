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

# V3.916 — ship Tectonic's package cache full. A fresh instance used to
# fetch every package and font on its first compile (47 s for a journal
# look in production on 2026-10-25; 2.8 s once cached), and Cloud Run
# scales to zero, so most compiles after a quiet spell paid it. Fetch every
# file a real compile has needed (warmup/tex-files.txt, names only) and
# compile the synthetic warm-up paper once per template (warmup/papers.tar.gz),
# which also builds the format file. Both lists come from scripts/paper-lab/warmup.py. A file
# that will not fetch does not stop the build: a compile still fetches what
# is missing.
ENV TECTONIC_CACHE_DIR=/opt/tectonic-cache
COPY warmup/tex-files.txt /tmp/warmup/tex-files.txt
# a local .tar.gz given to ADD is unpacked: one folder per template
ADD warmup/papers.tar.gz /tmp/warmup/papers/
RUN mkdir -p $TECTONIC_CACHE_DIR && cd /tmp && while read -r f; do \
      if [ -n "$f" ]; then tectonic -X bundle cat "$f" > /dev/null 2>&1 || echo "warm-up: could not fetch $f"; fi; \
    done < /tmp/warmup/tex-files.txt \
    && for d in /tmp/warmup/papers/*/; do \
      (cd "$d" && tectonic -X compile main.tex > /dev/null 2>&1) || echo "warm-up: $d did not compile"; \
    done \
    && rm -rf /tmp/warmup \
    && (du -sh $TECTONIC_CACHE_DIR || true)

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
