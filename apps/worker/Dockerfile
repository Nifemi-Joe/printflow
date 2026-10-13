# PrintFlow background worker: document scanning hand-off, DOCX→PDF conversion,
# PDF normalisation and previews, expiries, refunds, notifications, retention.
#   docker build -f apps/worker/Dockerfile -t printflow-worker .

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@printflow/worker..." \
 && pnpm --filter @printflow/worker build \
 && pnpm --filter @printflow/worker deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
# LibreOffice (Writer only, no GUI) converts DOCX; qpdf normalises PDFs; poppler renders previews.
# Metric-compatible fonts keep page counts close to what students see in Word.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui qpdf poppler-utils \
      fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out/node_modules ./node_modules
COPY --from=build --chown=root:root /out/package.json ./package.json
COPY --from=build --chown=root:root /out/dist ./dist
# The worker writes only to its temp directory (a tmpfs in docker-compose); each
# LibreOffice run gets its own throwaway profile there.
ENV TMPDIR=/tmp HOME=/tmp
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]
