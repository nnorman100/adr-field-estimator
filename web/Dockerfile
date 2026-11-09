# Production image for the rebuilt DryScope app (Next.js standalone output). Built by
# .github/workflows/web-release.yml and pushed by digest; the owner's first push is in
# docs/RUNBOOK.md, "Apply the central Terraform", step 6.
#
#   docker build --build-arg COMMIT_SHA=$(git rev-parse HEAD) -t <image> web
#
# The image holds no environment-specific values and no secrets: Cloud Run supplies APP_ENV and the
# rest at run time, and the app refuses to start without them (src/instrumentation.ts).
# Base images are pinned by digest; Dependabot (docker, /web) proposes updates.

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
# The commit is part of the image so /api/health can prove which code a revision runs.
ARG COMMIT_SHA
RUN echo "$COMMIT_SHA" | grep -Eqx '[0-9a-f]{40}' \
  || { echo 'Pass --build-arg COMMIT_SHA=<40-character commit>' >&2; exit 1; }
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS run
WORKDIR /app
ARG COMMIT_SHA
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=8080 \
  HOSTNAME=0.0.0.0 \
  APP_COMMIT=$COMMIT_SHA
# Files stay owned by root and read-only to the app; it runs as the image's unprivileged node user.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 8080
CMD ["node", "server.js"]
