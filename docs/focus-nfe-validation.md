# Focus NFe — Provider Validation (MOD-180)

Date: 2026-10-01 · Sources: doc.focusnfe.com.br (OpenAPI references, updated Apr–Jul 2026),
focusnfe.com.br (pricing page and guides), gov.br/nfse (national portal news), prefeitura.sp.gov.br
(Secretaria Municipal da Fazenda), Resoluções CGSN nº 189/2026 and nº 191/2026.
All claims verified against the cited pages on the date above; anything not verifiable is marked
UNVERIFIED. This document records provider capability only — it authorizes no account, subscription,
certificate upload, or live fiscal action (see §6).

## Decision summary

- **Route: NFS-e Nacional (`POST /v2/nfsen`), not the municipal `POST /v2/nfse` route.**
  São Paulo mandates the national issuer for Simples Nacional issuers from 2026-11-01; after that
  date SP's municipal systems serve only queries and retroactive emissions for covered issuers.
  Building on the municipal route would be a legacy design with a hard expiry.
- **Plan fit: Focus Solo** (1 CNPJ, 100 notes/mo, R$89.90 + R$0.10/extra note) fits a single-issuer
  deployment at current volume. Pricing is context only — purchase requires separate approval.
- **No blocking unsupported requirement found.** Open items for dependent issues are listed in §5.

## 1. API route and issuer onboarding prerequisites (AC: route + onboarding + cutover)

Focus NFe exposes **two distinct NFS-e APIs** with different endpoints, payloads, and company flags:

| | Municipal NFSe | NFS-e Nacional |
|---|---|---|
| Emit | `POST /v2/nfse?ref=` | `POST /v2/nfsen?ref=` (a DPS is sent; the NFS-e is generated on authorization) |
| Processing | Async queue; validated by the prefeitura | Async queue; validated by the Ambiente Nacional |
| Enable flag | `habilita_nfse` | `habilita_nfsen_homologacao` / `habilita_nfsen_producao` |
| Constraint | — | `habilita_nfsen_producao` **cannot be enabled together with `habilita_nfse`** on the same empresa in production |

Sources: doc.focusnfe.com.br/reference/nfse, /reference/nfse-nacional, /reference/emitir_nfse,
/reference/emitir_dps_nacional, /reference/criar_empresa (schema field descriptions),
focusnfe.com.br/guides/nfse/municipios-integrados/municipios-da-nfse-nacional/.

**Issuer onboarding prerequisites** (panel `app-v2.focusnfe.com.br/minhas_empresas` or
`POST /v2/empresas`):

- `cnpj`, `nome`/`nome_fantasia`, full BR address, `inscricao_municipal` (CCM),
  `regime_tributario` (1 = Simples Nacional, 2 = SN excesso sublimite, 3 = Regime Normal, 4 = MEI).
- Digital certificate: `arquivo_certificado_base64` (PFX/P12) + `senha_certificado`.
  **e-CNPJ A1 only** — A3 is rejected because it requires local hardware. Upload validation rejects
  wrong passwords, certificates not belonging to the CNPJ, and expired certificates (422 examples in
  the Empresas reference). For the national route the certificate must be **specific to the issuing
  company** — a matriz certificate cannot be used for a filial or vice-versa.
- Numbering control: `proximo_numero_nfsen_producao`/`_homologacao` and `serie_nfsen_*` on the
  empresa record.
- `enviar_email_destinatario` flag auto-emails the issued note to the tomador (production).
- `login_prefeitura`/`senha_prefeitura` fields exist for municipal routes that accept credential
  auth instead of a certificate — not needed for the national route.

**Municipality coverage / cutover:**

- The national route only works where the establishment municipality has adhered to the Emissor
  Nacional. Official coverage: gov.br/nfse "Monitoramento de Adesões" (all 5,571 municipalities in
  the convênio; every capital and every city >500k). Focus forwards to the same dashboard.
- São Paulo/SP: Secretaria da Fazenda page "Uso do Emissor Nacional da NFS-e será obrigatório"
  (prefeitura.sp.gov.br/web/fazenda/w/usoemissornacional, fetched 2026-10-01 — page returned 403 to
  the fetcher; content verified via search-indexed copy) states the national issuer is mandatory for
  **profissionais liberais/autônomos from 2026-08-03** and for **Simples Nacional companies from
  2026-11-01** (Resolução CGSN nº 189/2026; deadline moved from 2026-09-01 to 2026-11-01 by
  **Resolução CGSN nº 191, de 04/08/2026** — confirmed on the gov.br/nfse news page published
  11/08/2026). After the deadline, SP municipal systems remain only for consultas and emissões
  retroativas.
- MEI: national issuer already mandatory since 2023-09 (gov.br/nfse).
- For **non-Simples** issuers, São Paulo keeps its own municipal issuer (it shares data with the
  Ambiente de Dados Nacional per LC 214/2025). Whether SP accepts national issuance for non-Simples
  issuers today is **UNVERIFIED** — confirm with the accountant (MOD-178 regime decision) and Focus
  support/homologation (MOD-183) if ADM LTDA is not a Simples optant.
- National-guide caveats that must be re-verified at setup: (a) if the prefeitura has not registered
  the prestador's Inscrição Municipal in the national environment, `inscricao_municipal_prestador`
  must be **omitted** — sending it causes rejection; (b) municipalities can parametrize schema-
  optional fields as required (example: `codigo_tributacao_municipal_iss`) — SP's parametrization
  must be exercised in homologation.

## 2. Foreign identification and recipient/address combinations (AC: foreign ID + recipients)

NFS-e Nacional DPS schema (campos.focusnfe.com.br/nfse_nacional/EmissaoDPSXml.html — full field list;
main fields also in the `/v2/nfsen` OpenAPI schema) supports every required recipient combination:

- **Domestic PJ**: `cnpj_tomador` + `razao_social_tomador` + BR address (`codigo_municipio_tomador`
  IBGE-7, `cep_tomador`, `logradouro`, `numero`, `complemento`, `bairro`), optional
  `inscricao_municipal_tomador`, `telefone_tomador`, `email_tomador`.
- **Domestic PF**: `cpf_tomador` (11 digits) + same address fields.
- **Foreign PF/PJ**: `nif_tomador` (up to 40 chars) **or** `motivo_ausencia_nif_tomador`
  (0 = não informado na nota de origem, 1 = dispensado do NIF, 2 = não exigência do NIF — the
  legitimate-absence mechanism the project requires, so no foreign customer is forced to supply a
  Brazilian CPF); foreign address via `codigo_pais_ext_tomador` (ISO country), `cep_ext_tomador`,
  `nome_cidade_ext_tomador`, `regiao_ext_tomador`, plus the shared street/number/complement/bairro
  fields. Focus publishes a complete "Tomador Estrangeiro" example payload on the national guide.
- **Unidentified tomador**: the national model allows emitting with no tomador identification
  (Focus national guide, "Emissão sem tomador identificado").
- **Service export**: `tributacao_iss = 3` (Exportação de serviço) + `codigo_pais_exportacao`;
  supporting fields `modo_prestacao`, `vinculo_negocio`, `codigo_moeda`, `valor_servico_ext`,
  `mecanismo_comercio_ext_prestador`/`_tomador`, `numero_registro_exportacao`, `mdic`,
  `movimentacao_temporaria_bens`. (Whether a given sale qualifies as export is a MOD-178/MOD-179
  accountant decision — foreign residence alone does not select it.)
- **Issuer (prestador)** supports `cnpj_prestador`/`cpf_prestador`/`nif_prestador`,
  `inscricao_municipal_prestador`, `codigo_opcao_simples_nacional` (1 não optante, 2 MEI, 3 ME/EPP),
  `regime_tributario_simples_nacional`, `regime_especial_tributacao`.
- An `intermediario` group exists with the same ID/address structure (not needed by Moderaty).

Municipal-route comparison (evidence for "avoid legacy SP-only design"): `tomador` is schema-required
with `cpf`/`cnpj` keys, `EnderecoTomador` is Brazil-shaped only (IBGE município/UF/CEP — no foreign
address group); `nif`/`motivo_ausencia_nif` exist only as new Reforma Tributária fields that some
municipalities may ignore. Foreign recipients are first-class only on the national route.

## 3. Request/status/callback/reference behavior, documents, cancellation/substitution (AC: lifecycle)

- **Emit**: `POST /v2/nfsen?ref=<ref>` → sync pre-validation (missing fields, bad formats, unknown
  prestador cadastro → `400`/`422` immediately); accepted → `202 {status:"processando_autorizacao",
  ref, cnpj_prestador}` then queued for the Ambiente Nacional. Request acceptance ≠ authorization.
- **Reference semantics** (doc: /reference/referencia): `ref` is alphanumeric, unique per token —
  Focus returns `422 erro_validacao "Já existe um DPS com esta referência"` on duplicates, so it is
  the natural idempotency key. If authorization fails the same ref can be resent after correction;
  once a note is **authorized** (even if later canceled) the ref is permanently bound.
- **Consult**: `GET /v2/nfsen/{ref}` → oneOf `processando_autorizacao` | `autorizado` | `cancelado` |
  `erro_autorizacao` (enum also lists `negado`). `404 nao_encontrado` for unknown refs.
- **Authorized payload**: `numero` (NFS-e number), `codigo_verificacao` (usable on the national
  portal), `numero_rps`/`serie_rps`/`tipo_rps`, `data_emissao`, `url` (portal consulta), and
  **document retrieval**: `url_danfse` (DANFSe PDF) + `caminho_xml_nota_fiscal` (XML download path).
  Note: the Backups API does **not** cover NFSe/NFSen (it covers NFe/NFCe/CTe/MDFe/NFCom) — the XML
  must be fetched and stored by our pipeline.
- **Callbacks (gatilhos/webhooks)**: `POST /v2/hooks` registers `{event:"nfsen", url, cnpj, ...}`.
  Optional `authorization` + `authorization_header` set a caller-defined header value on every
  delivery — the provider-supported mechanism to authenticate callbacks (use it for a shared
  secret). Failed deliveries retry at 1 min / 30 min / 1 h / 3 h / 24 h, then stop; a lost
  notification can be replayed via `POST /v2/nfse/{ref}/hooks` equivalent —
  `reenviar_hook_nfsen` ("Solicitar reenvio de notificação").
- **Email**: `reenviar_email_nfsen` resends the note to a different email (sync confirm, async
  delivery); `enviar_email_destinatario` automates tomador delivery in production.
- **Cancellation**: `DELETE /v2/nfsen/{ref}` — **synchronous**; only `autorizado` notes; definitive
  and irreversible; optional `justificativa` body field. Failure mode is explicit: returns
  `status:"erro_cancelamento"` with error array (e.g., `"NFSe fora do prazo de cancelamento
  permitido"`), so cancellation deadlines exist but are municipality-parametrized — the accountant
  must confirm SP's window. Focus states **all adhered municipalities accept cancellation** under the
  national model.
- **Substitution**: supported natively — emit a new DPS carrying `chave_nfse_substituida` +
  `codigo_justificativa_substituicao` (01 desenquadramento SN, 02 enquadramento SN, 03/04 inclusão/
  exclusão retroativa de imunidade-isenção, 05 rejeição pelo tomador/intermediário, 99 outros) +
  `motivo_substituicao` (15–255 chars). (Municipal route has separate `numero_*_substituido` fields,
  municipality-permitting — another reason not to design around it.)

## 4. Sandbox vs production, certificates, limits, plan fit (AC: environments + plan)

- **Environments**: `https://homologacao.focusnfe.com.br` (no fiscal validity) and
  `https://api.focusnfe.com.br`, both under `/v2`. Same auth scheme; separate per-environment enable
  flags (`habilita_nfsen_homologacao` vs `_producao`) and numbering counters.
- **Authentication**: HTTP Basic — the per-company API **token** is the username, password empty
  (`Authorization: Basic base64(token + ":")`). Tokens are generated per empresa in the panel.
- **Rate limit**: 100 credits/minute per token (1 credit/request, any method/document). Responses
  carry `Rate-Limit-Limit`/`Rate-Limit-Remaining`/`Rate-Limit-Reset`; exhaustion → `HTTP 429`, wait
  for reset. Support can raise the limit for high-volume issuers. Source: Focus "Preparando seu
  sistema" guide + Postman collection text.
- **Certificate**: covered in §1 — e-CNPJ A1 PFX/P12 + password, validated on upload, company-
  specific for the national route. UNVERIFIED: whether the homologation environment requires a real
  certificate or accepts a test one — determine during MOD-183 environment setup (the DPS is
  digitally signed, so assume a real A1 cert is needed even for homologation).
- **Plans** (focusnfe.com.br/precos, fetched 2026-10-01; no setup fee, no lock-in, 30-day trial):
  - **Solo** — R$89.90/mo: 1 CNPJ, 100 notes included, R$0.10 per additional note. Emission of
    NFe/NFSe/NFCe/CTe/MDFe/NFCom/DCe + receipt of NFe/CTe/NFSe Nacional. Each emitted **or received**
    note counts as a plan unit.
  - Start — R$113.90/mo: 3 CNPJs (R$37.90/extra), 100 notes per CNPJ.
  - Growth — R$548/mo: unlimited CNPJs, 4,000 notes, R$0.12/extra.
  - Enterprise — custom, for >50k notes/mo or specific commercial terms.
- **Fit**: one issuer CNPJ (ADM LTDA) and low expected volume ⇒ **Solo is the right plan**; upgrade
  path is Start/Growth if sustained volume exceeds ~100 notes/mo. The "new municipality integration
  for R$199 within 15 days" guarantee is irrelevant for the national route (no per-municipality
  integration is needed).
- Uptime: 99.9% SLA advertised (AWS Brasil); public status page status.focusnfe.com.br.

## 5. Unsupported requirements and recorded decisions (AC: gaps + decision)

**No capability gap found** for the planned workflow: single Brazilian PJ issuer, domestic and
foreign PF/PJ recipients, async authorization with ref idempotency, status callbacks, XML/PDF
retrieval, cancellation and substitution, homologation environment. The design avoids the legacy
São Paulo-only route entirely.

Recorded decisions/constraints to carry into dependent issues:

1. **Target the national route exclusively** (`/v2/nfsen`, `habilita_nfsen_*`). Do not implement the
   municipal `/v2/nfse` path; production mutual-exclusion with `habilita_nfse` makes a dual-route
   company configuration impossible anyway.
2. **Persist the XML ourselves** — the Backups API does not cover NFS-e; fetch
   `caminho_xml_nota_fiscal`/`url_danfse` at authorization time.
3. **Authenticate webhooks** with `authorization`/`authorization_header` shared secret and treat
   polling (`GET /v2/nfsen/{ref}`) as the reconciliation fallback after the 5-attempt retry window.
4. **Ref strategy**: derive `ref` from the fiscal ledger row (stable, alphanumeric); never reuse a
   ref after authorization — a correction is a new ref + substitution/cancellation per MOD-191.
5. **Open items to resolve before/during setup** (not blockers to the route decision):
   - MOD-178 outstanding: confirm ADM LTDA's regime (Simples ⇒ national mandatory 2026-11-01 in SP)
     and IM status in the national environment (omit `inscricao_municipal_prestador` if absent).
   - SP's national parametrization (required-optional fields, cancellation deadline) — exercise in
     homologation (MOD-193).
   - Homologation certificate requirements — UNVERIFIED (§4).
   - Webhook `authorization` delivery format — verify the header is sent verbatim on each POST.
   - Whether `motivo_ausencia_nif_tomador` is mandatory when NIF absent — schema lists it
     "obrigatório" in that condition; confirm exact conditional requirement in homologation.

## 6. Purchase approval (AC: commercial)

**Not obtained and not authorized.** Focus Solo (R$89.90/mo) is documented as plan-fit context only.
Subscribing, creating the production account/token, or uploading a certificate each require separate
explicit approval. A 30-day free trial exists and is sufficient for homologation work (MOD-193) once
account creation itself is approved.
