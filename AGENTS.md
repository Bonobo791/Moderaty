# Repository Guidelines

## Agent Role

Act as a pragmatic repository contributor: make the smallest safe change,
validate it, and leave unrelated work untouched.

# Rules
Always fail loudly. 
NEVER write fallbacks that are silent.
ALWAYS write fallbacks that are loud, log to the server, and show to the user.
Always run codacy before committing any work.
Every test must fail if the real logic is wrong. If a test still passes when the function returns garbage, rewrite the test.

## Review Rules (learned from PR #4)

Security:

- Never return secrets, tokens, or raw third-party API responses to the
  client. Log full details on the server; return a generic error message.
- OAuth flows must use a `state` parameter: random value, HttpOnly cookie,
  verified in the callback.
- Routes that enroll, modify, or trigger privileged work must authenticate
  the caller and check ownership before acting.

Reliability:

- Validate required environment variables at handler start and throw a
  descriptive `error(500, ...)`; never use non-null assertions (`env.X!`).
  Failing loudly means failing with a clear message.
- In SvelteKit server code, read env vars via `$env/dynamic/private`
  (or `$env/static/private`), never `process.env`.
- Check `res.ok` before calling `.json()` on any external API response,
  and fail loudly on non-OK statuses.
- Build URLs with `new URL(path, base)` instead of string interpolation.

Architecture:

- Never replace an existing concurrency/scaling mechanism (leases, queues,
  batching) with a simpler synchronous loop. If a plan step conflicts with
  merged behavior, stop and reconcile with main instead of overwriting it.
- Cron/background work must isolate per-item failures and stay within
  serverless time limits.

Process:

- Keep PR title, description, and diff in sync; do not merge while a step's
  Verify failed or reviewer HIGH/P1 findings are unresolved.
- New complex server logic ships with tests for behavior (token exchange
  failure paths, auth rejection, per-channel error capture), per the
  existing test rule.

## Project Structure

Moderaty is a SvelteKit 2 app using Svelte 5 and TypeScript. Routes live in
`src/routes/`; reusable code belongs in `src/lib/`, with server-only modules in
`src/lib/server/`. Put static files in `static/`. Configure adapter-netlify in
`svelte.config.js`; Netlify deploys endpoints as standard Node Functions. Keep
`vite.config.ts` for Vite-only settings. Do not edit
generated `.svelte-kit/` files or commit build output.

## Commands

Use Node 24 and npm 11.

- `npm run dev` — start local development.
- `npm run check` — run SvelteKit sync and strict diagnostics.
- `npm run build` — create the Netlify deployment build.
- `npm run preview` — serve the production build locally.

- `npm run test` — run the Vitest suite (see
  `src/routes/api/auth/google/oauth.test.ts`).

`npm run check` and `npm run test` are required before a PR.

## Code Style

Use TypeScript and Svelte 5 runes (`$state`, `$derived`, `$props`, and
`{@render}`) for new code. Keep legacy `export let`, `$:`, or `<slot>` syntax
only for a documented, maintainer-approved compatibility exception. Use tabs
and SvelteKit `+page`, `+layout`, and `+server` conventions. Prefer `$lib`
imports, platform APIs, and installed dependencies.

## Commits, Security, and Licensing

Use focused, imperative commits such as `step N: <change>` or `chore: <change>`.
PRs need behavior, verification, linked issues, and UI screenshots where useful;
contributors must complete the Contributor License Agreement (CLA). Keep secrets
out of commits: document non-sensitive values in `.env.example`, keep `.env` and
`.env.*` ignored, and reserve `.env.test` for test configuration. Commit a
secret-like test value only when it is synthetic and a maintainer approves the
documented exception. Preserve [LICENSE](LICENSE) and [COMMERCIAL.md](COMMERCIAL.md).

## License Headers

Add this notice to new comment-capable source and documentation files, using
the file's native comment syntax. Do not add comment headers to JSON or other
data formats.

```text
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
```
