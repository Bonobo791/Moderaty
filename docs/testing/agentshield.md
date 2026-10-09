# AgentShield repository scan

Run `npm run scan:agents` with Node 24. This uses the installed, exact
`ecc-agentshield@1.6.0` dev dependency and scans configuration surfaces locally.
It does not execute hooks, call a model, apply automatic fixes, or audit the
application's TypeScript behavior.

The upstream CLI has no targeted exclusion settings in this version. The
repository command retains its complete raw JSON report and writes a separate
reviewed JSON report under a unique `/tmp/moderaty-agentshield-*` directory.
It prints both paths and counts every exclusion. Upstream grades describe the
raw findings; they are not presented as a grade for the reviewed report.
Remaining critical/high findings exit 2; scanner/report failures exit 1;
medium/low findings remain visible warnings.

Reviewed exclusions are limited to:

- Findings inside generated `.stryker-tmp/` copies, outside source scope.
- Azure-key matches in the root lockfile whose exact matched value is the
  line's standard npm SHA-512 integrity hash. Other secret findings remain.
- Missing permission/hook warnings on `.vscode/extensions.json` only while
  the file contains extension recommendation arrays and no other settings.
- Missing-hook policy suggestions on the two bundled Superpowers foreign
  hook manifests only while its Codex manifest explicitly sets `hooks: {}`.
  This command evaluates the repository for Codex. Auditing active Claude or
  Cursor hooks requires the raw scan of that harness's actual installation.
  Other hook findings, including exfiltration, are never excluded by this rule.

Local npm installs now inherit `ignore-scripts=true` from `.npmrc`, matching
CI and Docker. `npm run check` explicitly synchronizes SvelteKit; check, build,
and test commands remain available. When a reviewed dependency actually needs
an install hook, run that specific operation explicitly after reviewing it.

No installed vendor manifests or security-hook behavior have been modified.
