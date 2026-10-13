# PrintFlow web app (Next.js standalone output).
#   docker build -f apps/web/Dockerfile --build-arg API_ORIGIN=http://api:4000 -t printflow-web .
#
# API_ORIGIN is baked into the /api/* rewrite at build time, so it must be the
# address the web container uses to reach the API (an internal hostname is fine).

FROM node:22-bookworm-slim AS build
ARG API_ORIGIN=http://api:4000
ARG NEXT_PUBLIC_ONBOARDING_EMAIL=
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1 \
    API_ORIGIN=$API_ORIGIN NEXT_PUBLIC_ONBOARDING_EMAIL=$NEXT_PUBLIC_ONBOARDING_EMAIL
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@printflow/web..." \
 && pnpm --filter @printflow/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=root:root /src/apps/web/.next/standalone ./
COPY --from=build --chown=root:root /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=root:root /src/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
