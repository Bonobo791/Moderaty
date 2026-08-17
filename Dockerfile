# syntax=docker/dockerfile:1
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
#
# Coolify deployment image (docs/COOLIFY_BUNNY.md). Coolify's Dockerfile
# build pack passes environment variables flagged as build variables as
# --build-arg, so the TURSO_* ARGs below reach the build stage.

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Same deploy gate as Netlify (scripts/netlify-migrate.mjs): migrate + verify
# the database BEFORE building, so an image can never be built against an
# un-migrated or unverified schema. CONTEXT is unset here (the conservative
# default), so the gate always runs — failing the image build loudly.
# The TURSO_* values are set for this single RUN only (inline env), so the
# credentials never become baked ENV in the image.
ARG TURSO_DATABASE_URL
ARG TURSO_AUTH_TOKEN
RUN TURSO_DATABASE_URL=$TURSO_DATABASE_URL TURSO_AUTH_TOKEN=$TURSO_AUTH_TOKEN \
	node scripts/netlify-migrate.mjs
# Coolify target builds the standalone node server (adapter-node); Netlify
# builds leave MODERATY_ADAPTER unset and keep adapter-netlify.
ENV MODERATY_ADAPTER=node
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000
COPY --from=builder /app/build build/
# scripts/ ships so the in-container commands work: the Coolify Scheduled
# Task cron ticker and the post-deployment Bunny purge both run
# `node scripts/...` inside this image.
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
