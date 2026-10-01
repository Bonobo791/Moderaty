# AdaFlow — NFSe Import API Validation (MOD-226)

Date: 2026-10-01 · Sources: live endpoint probes against app.adaflow.com, app.adaflow.com ToS
(/termos-de-uso), adaflow.com marketing pages, Adaflow help center
(cloudchat5.cloudhumans.com/hc/central-de-ajuda-adaflow).
Probe results reproduced below; anything not verifiable without a session is marked UNVERIFIED.
This document records provider capability only — no credentials were requested, stored, or used,
and no import was performed (guardrail in §5).

## Decision summary

- **AdaFlow exposes a real programmatic surface**: a Bearer-token MCP endpoint at `POST /mcp` and a
  session/Bearer-gated REST API under `https://app.adaflow.com/api/v1` that includes the NFSe import
  routes referenced by `createNfseImport`. Integration is feasible; the exact payload contract is
  behind the docs login and is the remaining gap.
- **Access path**: AdaFlow is ADM LTDA's accounting provider, and "API de importação de NFSe" plus
  "integrações via MCP e API" are advertised client features (2026 launch, included in client plans).
  Request the API token via the account's integrations area or AdaFlow support, then fetch the
  OpenAPI spec (`/api_docs.json`) to fill the contract blanks for MOD-227.
- **No blocking unsupported requirement found.** Contract unknowns gate MOD-227's payload design
  only — not the export approach.

## Name-collision warning

Do **not** confuse this AdaFlow (app.adaflow.com — Adaflow Tecnologia LTDA, São Paulo accounting
platform for PJ service providers) with **Adalink's "Adaflow"** (app.adalink.ai,
`@adaflow/sdk` on npm, adalink-integration-kit on GitHub — an unrelated AI-agent platform whose docs
surface in search results). None of the Adalink material applies here.

## 1. API base URL, authentication, and credential provisioning (AC: access path)

Verified by direct probes on 2026-10-01:

| Probe | Result |
|---|---|
| `GET /api_docs` | `302` → `/users/sign_in` (docs UI requires session login) |
| `GET /api_docs.json` / `GET /api_docs.yaml` | `401 {"error":"Para continuar, faça login ou registre-se."}` — spec exists, session-gated |
| `POST /mcp` (and `/mcp/sse`, `/mcp/messages`) | `401 {"jsonrpc":"2.0","error":{"code":-32001,"message":"Não autorizado. Forneça um token Bearer válido."}}` — **MCP endpoint exists, auth = `Authorization: Bearer <token>`** |
| `GET /api/v1/me` | `401` — REST API base confirmed at `/api/v1` |
| `POST /api/v1/nfses` | `401` — NFSe create route exists |
| `GET|POST /api/v1/nfses/import` | `401` — **the `createNfseImport` route** (tag `NFSes`) |
| `GET /api/v1/nfses/import_file` | `401` — file-upload variant exists |
| `GET /api/v1/nfses/imports` | `401` GET / `404` POST — import listing exists |
| `POST /api/v1/users` | `422` — exists (signup); validates input |
| `api.adaflow.com`, `mcp.adaflow.com`, `developers.adaflow.com`, `docs.adaflow.com` | DNS/connection fails — no dedicated host; everything lives on `app.adaflow.com` |
| `app.adaflow.com.br` | `301` → `app.adaflow.com` |

- **Auth**: Bearer token for the programmatic surface (per the `/mcp` challenge). Whether the REST
  `/api/v1/*` routes accept the same Bearer token or session cookie is UNVERIFIED until a token is
  issued — expected to be Bearer, consistent with MCP and rswag-style `createNfseImport` naming.
- **Credential provisioning**: per ToS §4.7 API access is granted "a clientes selecionados" and
  credentials are personal and revocable; marketing pages state API/MCP integrations ship in every
  client plan since 2026. Path: log into app.adaflow.com and look for an Integrações/API section to
  mint a token; if absent, open a support request (in-app chat or WhatsApp +55 11 5026-8973) citing
  the NFSe import use case. UNVERIFIED which of the two AdaFlow actually uses.

## 2. `createNfseImport` contract (AC: payload + note identity)

Verified: the operation lives under tag `NFSes` and maps to routes that exist
(`/api/v1/nfses/import`, `/api/v1/nfses/import_file`, `/api/v1/nfses/imports`). The presence of both
`import` and `import_file` suggests structured-JSON and file-upload (XML) variants — **UNVERIFIED**
which accepts what, and what fields identify a note (chave de acesso, NFS-e number, verification
code). The full OpenAPI spec must be pulled from `/api_docs.json` once a session/token exists.

Everything else about the payload — required fields, how the prestador/tomador are identified,
whether foreign-issued NFS-e XML (national standard) is accepted — is **UNVERIFIED** and listed as
the first task when access lands.

## 3. Idempotency, cancellation/substitution, limits, sandbox (AC)

All **UNVERIFIED** — gated behind the docs login:

- Whether re-importing the same note deduplicates or 4xx-errors (drives MOD-227's retry design).
- Whether cancellation/substitution must be pushed (and via which field/endpoint) or whether
  AdaFlow reconciles against the national environment itself.
- Rate limits, payload size caps, and whether a sandbox/test area exists (the `422` on
  `/api/v1/users` shows request validation is real, not a stub).
- Whether the MCP server exposes an import tool as an alternative to REST — worth checking during
  credential setup since `/mcp` answers with proper JSON-RPC errors.

## 4. Unsupported requirements and decisions (AC: gaps + decision)

**None blocking found.** The remaining unknowns are contract details, not capability gaps:

1. **Route exists** — `POST /api/v1/nfses/import[_file]` confirmed live; REST + Bearer auth is the
   integration mechanism, with `/mcp` as a possible alternative surface.
2. **Spec retrieval is the next step** — pull `/api_docs.json` under the client account immediately
   after token issuance; the spec closes every UNVERIFIED item above in one step.
3. **Design constraint for MOD-227** (recorded): export only after Focus `autorizado`; dedupe key =
   our fiscal-ledger ref; failures isolated from billing/issuance.
4. **Fallback if the API stalls**: AdaFlow already reads client extratos via Open Finance and its
   own NF emission — worst case the notes could be delivered as files, but that loses automation;
   keep the API path as the only accepted design.
5. **Risk to flag**: `createNfseImport` might be scoped to importing notes *issued outside AdaFlow*
   for bookkeeping (the expected case) — or it could require the note to already exist in the
   national environment. Either works for us (Focus-authorized NFS-e are in the ADN), but confirm
   which semantics apply when the spec is lifted.

## 5. Purchase/credential approval (guardrail)

**No credential was provisioned or used; nothing was authorized.** Next action is a human one:
request the API token (in-app integrations area or AdaFlow support), then pull the spec and attach
the answered contract to MOD-226 before MOD-227 implementation starts.
