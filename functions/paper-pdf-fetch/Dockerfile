# Paper PDF fetch service — headless-Chrome open-access PDF grabber (V3.501)
#
# Built as a Cloud Run service (not a Firebase Function) so it can ship a
# full Chromium + its shared-library deps. It loads a DOI/landing page in
# headless Chrome, finds the article PDF (citation_pdf_url meta / a PDF
# response), and uploads it to Storage. This is the fallback the plain
# server-side fetcher (functions/fetch-paper-pdf.js) hands off to when the
# PDF is gated behind page JS.
#
# Build + deploy (Alex, once):
#   cd functions/paper-pdf-fetch
#   gcloud run deploy paper-pdf-fetch \
#     --source . \
#     --region us-central1 \
#     --allow-unauthenticated=false \
#     --memory 2Gi \
#     --timeout 120 \
#     --max-instances 3
#
#   gcloud run services add-iam-policy-binding paper-pdf-fetch \
#     --region=us-central1 \
#     --member=serviceAccount:mcgheelab-f56cc@appspot.gserviceaccount.com \
#     --role=roles/run.invoker
#
# Then confirm the URL in functions/paper-pdf-fetch-proxy.js (CLOUD_RUN_URL)
# matches the deployed service and `firebase deploy --only functions:paperPdfFetchProxy`.

FROM node:20-bookworm-slim

# Chromium runtime libraries Puppeteer's bundled Chrome needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
      libatk1.0-0 libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
      libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
      libxrandr2 wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
# Let Puppeteer download its matched Chromium into the image at install time.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
