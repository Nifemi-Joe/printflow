# PrintFlow API. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t printflow-api .
# The same image runs migrations: `node dist/migrate.js up`.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@printflow/api..." \
 && pnpm --filter @printflow/api build \
 && pnpm --filter @printflow/api deploy --prod --legacy /out \
 && mkdir -p /out/db && cp -r db/migrations /out/db/migrations

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production MIGRATIONS_DIR=/app/db/migrations PORT=4000
WORKDIR /app
COPY --from=build --chown=root:root /out/node_modules ./node_modules
COPY --from=build --chown=root:root /out/package.json ./package.json
COPY --from=build --chown=root:root /out/dist ./dist
COPY --from=build --chown=root:root /out/db ./db
# Files are root-owned and read-only to the runtime user; the container also runs read_only.
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
