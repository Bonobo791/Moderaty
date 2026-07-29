# Repository Guidelines

## Project Structure

Moderaty is a SvelteKit 2 application using Svelte 5 and TypeScript. Routes and
pages live in `src/routes/`; reusable code belongs in `src/lib/`, with
server-only modules under `src/lib/server/` as they are added. Put static files
in `static/`. `vite.config.ts` uses `@sveltejs/adapter-node`; database work is
intended to use Drizzle ORM with libSQL. Do not edit generated `.svelte-kit/`
files or commit build output.

## Build, Test, and Development Commands

Use Node 24 and npm 11 (the repository enables strict engine checks).

- `npm run dev` — start the Vite development server.
- `npm run check` — run SvelteKit sync and `svelte-check` in strict mode.
- `npm run build` — create the production Node build.
- `npm run preview` — serve the production build locally.

There is no test runner yet; `npm run check` is the required verification gate.

## Coding Style & Naming

Use TypeScript with `<script lang="ts">` and Svelte 5 runes (`$state`,
`$derived`, `$props`, and `{@render}`). Do not introduce Svelte 4 patterns such
as `export let`, `$:`, or `<slot>`. Use tabs for indentation, `$lib` imports for
`src/lib`, and SvelteKit’s `+page`, `+layout`, and `+server` naming conventions.
Prefer the existing platform APIs and installed dependencies before adding new
packages.

## Testing Guidelines

Run `npm run check` before opening a pull request. If tests are introduced,
choose a lightweight framework, add its npm scripts, and place tests near the
code they cover with descriptive names.

## Commits & Pull Requests

Existing history uses short imperative messages, including `step N: <change>`
and `chore: <change>`. Keep commits focused and follow that style. Pull
requests should describe the behavior changed, include verification commands,
link related issues, and add screenshots for UI changes. Contributors must
complete the CLA requested by CLA Assistant; do not commit directly to `main`.

## Security & Licensing

Never commit `.env` files or credentials; use `.env.example` for documented
configuration. Keep secrets and OAuth tokens server-side. Preserve the project’s
AGPLv3/commercial licensing notices in `LICENSE` and `COMMERCIAL.md`.

# Mandatory File Text

This must always be added at the top of every file:

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