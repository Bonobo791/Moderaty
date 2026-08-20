# syntax=docker/dockerfile:1
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher
#
# Licensed under the PolyForm Shield License 1.0.0; you may not use
# this file except in compliance with the License. You may obtain a
# copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
#
# The software is provided "as is", without warranty or condition of
# any kind, express or implied. See the License for the specific
# language governing permissions and limitations under the License.
# A copy of the License is included in the LICENSE file at the
# repository root.
#
# Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
#
# Coolify deployment image (docs/COOLIFY_BUNNY.md). Coolify's Dockerfile
# build pack passes environment variables flagged as build variables to the
# build; with "Use Docker Build Secrets" enabled they arrive as BuildKit
# secrets (`--secret id=KEY,env=KEY`), which the migrate gate below mounts
# for its single RUN.

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: never run third-party lifecycle scripts during install
# (docker:S6505). Safe here: esbuild's binary ships as a platform
# optionalDependency (its install script is only a validator) and fsevents is
# macOS-only; the root `prepare` (svelte-kit sync) is skipped too, but the
# SvelteKit vite plugin regenerates .svelte-kit itself during `vite build`.
RUN npm ci --ignore-scripts
COPY . .
# Same deploy gate as Netlify (scripts/netlify-migrate.mjs): migrate + verify
# the database BEFORE building, so an image can never be built against an
# un-migrated or unverified schema. CONTEXT is unset here (the conservative
# default), so the gate always runs — failing the image build loudly.
# The TURSO_* values arrive ONLY as BuildKit secret mounts scoped to this
# single RUN (docker:S6472 — never ARG/ENV, so they never appear in build
# args, image history, or baked layers). Coolify passes them as
# `--secret id=KEY,env=KEY` when "Use Docker Build Secrets" is enabled in the
# app's Environment Variables settings (see docs/COOLIFY_BUNNY.md §3.4);
# without it the mounts are empty and the gate's preflight aborts with an
# actionable `TURSO_DATABASE_URL is not set` error — a build without the
# secrets always fails loudly here.
RUN --mount=type=secret,id=TURSO_DATABASE_URL,env=TURSO_DATABASE_URL \
	--mount=type=secret,id=TURSO_AUTH_TOKEN,env=TURSO_AUTH_TOKEN \
	node scripts/netlify-migrate.mjs
# Coolify target builds the standalone node server (adapter-node); Netlify
# builds leave MODERATY_ADAPTER unset and keep adapter-netlify.
ENV MODERATY_ADAPTER=node
# Bake the deployed commit into a static marker BEFORE the build so the
# bunny-purge workflow can wait for this deploy to serve the pushed commit.
# SOURCE_COMMIT is Coolify's predefined build-time variable (git is NOT
# installed in the alpine builder). With "Use Docker Build Secrets" on,
# Coolify delivers it as `--secret id=SOURCE_COMMIT,env=SOURCE_COMMIT`, so it
# is mounted here like the TURSO_* credentials; otherwise it arrives as
# `--build-arg SOURCE_COMMIT` (the ARG below). The script falls back to
# 'unknown' when absent. Requires Coolify's "Include Source Commit in Build"
# app setting (docs/COOLIFY_BUNNY.md §3.4).
ARG SOURCE_COMMIT
RUN --mount=type=secret,id=SOURCE_COMMIT,env=SOURCE_COMMIT \
	node scripts/write-commit-marker.mjs
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000
COPY --from=builder /app/build build/
# scripts/ ships so the in-container commands work: the Coolify Scheduled
# Task cron ticker runs `node scripts/...` inside this image. (The Bunny CDN
# purge is NOT in-container — it runs from .github/workflows/bunny-purge.yml
# with a zone-scoped key, so no purge credential ever ships in the image.)
COPY --from=builder /app/scripts scripts/
COPY --from=builder /app/package.json package.json
COPY --from=builder /app/node_modules node_modules/
# Run as an unprivileged user; Coolify healthchecks hit /api/health.
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "build/index.js"]
