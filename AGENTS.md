<!--
Moderaty — YouTube Comment Auto-Moderation Tool
Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify it under
the GNU Affero General Public License, version 3 or later. It is provided
without warranty; see LICENSE. Commercial licensing:
contact@marketingprowess.simplelogin.com — see COMMERCIAL.md.
-->

# Repository Guidelines

## Project Structure

Moderaty is a SvelteKit 2 app using Svelte 5 and TypeScript. Routes live in
`src/routes/`; reusable code belongs in `src/lib/`, with server-only modules in
`src/lib/server/`. Put static files in `static/`. Configure adapter-node in
`svelte.config.js`; keep `vite.config.ts` for Vite-only settings. Do not edit
generated `.svelte-kit/` files or commit build output.

## Commands

Use Node 24 and npm 11.

- `npm run dev` — start local development.
- `npm run check` — run SvelteKit sync and strict diagnostics.
- `npm run build` — create the Node deployment build.
- `npm run preview` — serve the production build locally.

No test framework exists yet; `npm run check` is required before a PR.

## Code Style

Use TypeScript and Svelte 5 runes only (`$state`, `$derived`, `$props`, and
`{@render}`); never introduce `export let`, `$:`, or `<slot>`. Use tabs and
SvelteKit `+page`, `+layout`, and `+server` conventions. Prefer `$lib` imports,
platform APIs, and installed dependencies.

## Commits, Security, and Licensing

Use focused, imperative commits such as `step N: <change>` or `chore: <change>`.
PRs need behavior, verification, linked issues, and UI screenshots where useful;
contributors must complete the CLA. Never commit secrets: document values in
`.env.example`, keep `.env` and `.env.*` ignored, and reserve `.env.test` for
test configuration. Preserve [LICENSE](LICENSE) and [COMMERCIAL.md](COMMERCIAL.md).

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
