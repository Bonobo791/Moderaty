# Moderaty

**Never read another hate comment.** Moderaty is an open-source YouTube comment
protection platform for creators. It applies the creator's rules first, uses AI
as a second opinion, and sends uncertain decisions to a human review queue.

[![Codacy Badge](https://app.codacy.com/project/badge/Grade/a971fb52cb6142efab9a17572f3e3f57)](https://app.codacy.com/gh/Bonobo791/Moderaty/dashboard?utm_source=github&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)

[![Quality gate status](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=bugs)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Code Smells](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=code_smells)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Duplicated Lines (%)](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=duplicated_lines_density)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Lines of Code](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=ncloc)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Technical Debt](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=sqale_index)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=Bonobo791_Moderaty&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=Bonobo791_Moderaty)

[![CodeScene general](https://codescene.io/images/analyzed-by-codescene-badge.svg)](https://codescene.io/projects/83771)
[![CodeScene Hotspot Code Health](https://codescene.io/projects/83771/status-badges/hotspot-code-health)](https://codescene.io/projects/83771)

## What it does

- Connects YouTube channels through Google OAuth.
- Matches top-level comments against keyword, regex, and blocked-user rules.
- Applies `hold`, `reject`, `delete`, or `ban` actions to matching comments.
- Uses OpenAI moderation and an optional per-channel tone pass for comments that
  rules do not decide.
- Routes AI failures and borderline scores to a human review queue instead of
  silently approving or rejecting them.
- Records decisions in an audit log and supports `DRY_RUN=true` previews.

Each scheduled run is bounded and checkpointed. It processes one eligible
channel, records enforcement work in the database before writing to YouTube,
and reconciles unfinished actions on a later run.

## Repository overview

Moderaty is a SvelteKit 2 application using Svelte 5, TypeScript, and a
**dual deploy adapter** (the choice is the build-time `MODERATY_ADAPTER` env):
the default Netlify adapter, or adapter-node for the self-hosted Coolify +
Bunny CDN target (see `DEPLOY.md` and `docs/COOLIFY_BUNNY.md`). Server code
calls the Google and OpenAI HTTP APIs directly; there are no auth, Google, or
OpenAI SDKs in the dependency tree.

| Path | Purpose |
| --- | --- |
| `src/routes/` | Landing page, authenticated app pages, OAuth routes, and cron API |
| `src/lib/` | Shared Svelte components, landing-page content, and server modules |
| `src/lib/server/` | Sessions, OAuth, encryption, rules, moderation, pipeline, and database access |
| `drizzle/` | Database migrations for libSQL/SQLite and Turso |
| `netlify/functions/cron.mjs` | Scheduled Netlify function that invokes the cron endpoint |
| `Dockerfile` | Coolify image: migrate+verify gate, node build, non-root runtime (see `docs/COOLIFY_BUNNY.md`) |
| `scripts/bunny-purge.mjs` | Bunny CDN cache purge, run from `.github/workflows/bunny-purge.yml` after production deploys |
| `scripts/dev-cron.mjs` | Cron ticker: local dev loop, or Coolify's in-container scheduled task (`--once`) |
| `scripts/` | Local demo-data seeding, live tone calibration, and deploy helpers |
| `docs/` | Manual end-to-end verification notes and the Coolify runbook (`docs/COOLIFY_BUNNY.md`) |
| `DEPLOY.md` | Netlify, Turso, Google OAuth, and cron deployment instructions |
| `docs/COOLIFY_BUNNY.md` | Coolify + Bunny CDN target: implementation plan and operator runbook |
| `EXECUTION_PLAN_YouTube_Comment_Moderator.md` | Implementation plan and system invariants |

The app uses local SQLite through `file:local.db` during development and Turso
in production. Sessions are stored in the database, and YouTube refresh tokens
are encrypted before storage. The application is multi-user: authenticated
queries and mutations are scoped to the signed-in user's channels.

## Local development

### Prerequisites

- Node.js 24+
- npm 11+
- Google Cloud OAuth credentials for sign-in and YouTube channel access
- An OpenAI API key for live moderation runs

### Setup

```bash
git clone https://github.com/Bonobo791/Moderaty.git
cd Moderaty
npm ci
cp .env.example .env
```

Fill in `.env` with the required values. For a local database, keep
`TURSO_DATABASE_URL=file:local.db` and start with `DRY_RUN=true`. Apply the
migrations before starting the app:

```bash
set -a
source .env
set +a
npm run db:migrate
npm run dev
```

Open `http://localhost:5173`. Google OAuth redirect URIs and production setup
are documented in [DEPLOY.md](DEPLOY.md); the manual credential and smoke-test
checklist is in [docs/e2e-verification.md](docs/e2e-verification.md).

To populate the local app with a safe demo channel and sample queue data:

```bash
node --env-file=.env scripts/seed-dev.mjs
node --env-file=.env scripts/seed-dev.mjs --reset
```

The seed script refuses non-local database URLs.

## Configuration

Copy [.env.example](.env.example) and provide these values as appropriate:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client credentials |
| `APP_URL` | Canonical app URL used for OAuth redirects |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Local SQLite or production Turso connection |
| `OPENAI_API_KEY` | AI moderation and tone scoring |
| `OPENAI_TONE_MODEL` | Optional tone model; defaults to `gpt-4.1-nano` |
| `CRON_SECRET` | Secret for scheduled and manual cron requests |
| `ENCRYPTION_KEY` | Key used to encrypt stored YouTube refresh tokens |
| `DRY_RUN` | Must be `true` or `false`; `true` records audit previews without durable moderation changes |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` | Optional Mercado Pago BRL prepaid-credit checkout credentials |
| `MERCADOPAGO_ENVIRONMENT`, `MERCADOPAGO_PRICE_CREDITS_*_BRL_CENTS` | Optional Mercado Pago mode and BRL bundle prices in cents |

Never commit `.env` or real credentials. Netlify environment-variable setup is
covered by [DEPLOY.md](DEPLOY.md).

## Useful commands

```bash
npm run dev          # Start the development server
npm run check        # Run SvelteKit sync and strict TypeScript diagnostics
npm run test         # Run the Vitest suite
npm run build        # Build (default Netlify adapter; MODERATY_ADAPTER=node for Coolify)
npm run preview      # Serve the production build locally
npm run db:migrate   # Apply Drizzle migrations
```

The test suite includes route, OAuth, session, database, moderation, pipeline,
and UI-state tests. The tone evaluator is a separate live API check:

```bash
node scripts/tone-eval.mjs
```

## Accounts and hosting

Users sign in with Google identity (`openid email profile`) and then grant a
separate `youtube.force-ssl` consent to connect a channel. Self-hosted
instances use the same code path and bring their own Google, OpenAI, and Turso
credentials. Moderaty supports two deploy targets: the managed **Netlify**
target (Scheduled Function, see [DEPLOY.md](DEPLOY.md)) and the self-hosted
**Coolify + Bunny CDN** target (Dockerfile + in-container scheduled task, see
[docs/COOLIFY_BUNNY.md](docs/COOLIFY_BUNNY.md)); both use Turso as the
production database and share the same `DRY_RUN`-first verification flow.

## License

Moderaty is source-available under a dual-license model:

- **PolyForm Shield 1.0.0:** [LICENSE](LICENSE) — free to use, self-host,
  modify, and distribute, including for commercial purposes, provided that
  you do not use Moderaty to provide a product or service that competes with
  Moderaty or another product or service provided by Advanced Digital
  Marketing LTDA using Moderaty.
- **Commercial license:** available for competing hosted services,
  competing white-label products, competing SaaS offerings, or other uses
  not permitted by the PolyForm Shield License.

For commercial licensing, contact
[contact@AdvancedDigitalMarketingLTDA.com](mailto:contact@AdvancedDigitalMarketingLTDA.com).

See [COMMERCIAL.md](COMMERCIAL.md).

Copyright (C) 2026 Advanced Digital Marketing LTDA.
