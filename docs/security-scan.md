<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. SPDX-License-Identifier: MIT-0 -->

# Security scan summary & remediation

This is the human-readable summary of the automated security scans run over this
sample: ProtoShield v0.15.0-rc14 (Semgrep, Bandit, CDK NAG, Checkov, Gitleaks,
CVE, IAM least-privilege, license headers), a Slingshot pass (Bandit + Semgrep
OSS), and [ASH v3](https://github.com/awslabs/automated-security-helper)
(Bandit, Semgrep, Opengrep, Checkov, detect-secrets, Grype, npm-audit). It
records what each scanner found, what was fixed, and what is intentionally
accepted for a teaching demo.

It is the code-scan companion to the design-level [threat model](./threat-model/README.md).
Read them together: the threat model reasons about *what an attacker (primarily
the agent itself) could do*; this scan checks *how the code and IaC are written*.

## Results at a glance

| Scanner | Critical | High | Medium | Low | Info | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Secrets (Gitleaks) | 0 | 0 | 0 | 0 | 0 | Clean |
| Checkov (IaC) | 0 | 0 | 0 | 0 | 0 | Clean |
| CDK NAG | 0 | 0 | 0 | 0 | 0 | Not wired (see below) |
| License headers | 0 | 0 | 0 | 0 | 25 | 100% MIT-0 compliant |
| Semgrep | 0 | 3 | 0 | 0 | 0 | Remediated |
| Bandit | 0 | 0 | 2 | 5 | 0 | Remediated |
| IAM least-privilege | 0 | 3 | 1 | 0 | 3 | 1 fixed, 3 accepted+documented |
| CVE (deps) | 0 | 3 | 10 | 2 | 0 | Fixed (vite/esbuild); 1 accepted (bundled) |

No secrets, no infrastructure misconfigurations, and full license-header
compliance. The remaining items are addressed below.

The ASH v3 run (after the fixes below, most recently re-run on 2026-08-11
against the tree including Act 6 and the first-run tour) reports zero
actionable findings on committed files: its remaining hits are exclusively in
generated or vendored artifacts (`node_modules/`, `cdk.out/`, `outputs.json`)
that are git-ignored and never published, plus the single bundled
`brace-expansion` advisory documented in the accepted-risk section.

## Remediated

- **License headers (25/25 at scan time).** MIT-0 / SPDX headers added to every
  source file (`.py`, `.sh`, `.ts`, `.tsx`, `.css`, `index.html`); files added
  since the scan carry the same header. Comments only — zero runtime impact.
- **Semgrep `detect-child-process` (high).** The CDK bundling hook in
  `cdk/lib/core-stack.ts` used `execSync()` with an interpolated command string.
  Replaced with `execFileSync('python3', [...args])` (array form, no shell), so
  the `outputDir` path can no longer be interpreted as shell.
- **Semgrep `dynamic-urllib-use` (high) + Bandit `B310` (medium).**
  `scripts/smoke_test.py` no longer uses `urllib.request` at all: HTTP calls go
  through a `urllib3.PoolManager`, which only speaks http(s) and verifies TLS
  certificates by default, plus an explicit `https://` assertion on the API base
  and on every request. The flagged pattern is structurally gone.
- **Semgrep `dangerous-subprocess-use-audit` (high) + Bandit `B404`/`B603`/`B607`
  (low) — subprocess.** The smoke test no longer shells out to the AWS CLI:
  Cognito test-user create/authenticate/delete now use the boto3 `cognito-idp`
  client directly, so there is no `subprocess` import left to audit.
- **IAM — `bedrock-agentcore:InvokeGateway` (high).** The agent Lambda's resource
  list was narrowed from `[gwArn, "${gwArn}/*"]` to `[gwArn]`. The agent invokes
  the gateway itself; it does not manage gateway sub-resources.
- **IAM — `bedrock:InvokeModel` scoping (previously wildcard).** The agent's model
  permission is scoped to the configured model's `foundation-model` and
  `inference-profile` ARNs rather than `foundation-model/*` + `inference-profile/*`.
- **CVE — `vite` (13 advisories) and `esbuild` (1).** Fixed by moving `vite` from
  6.0.7 to 6.4.3 (same major; the official patched release per npm audit), which
  also pulls a patched esbuild. `npm audit` on `frontend/` now reports 0
  vulnerabilities. `aws-cdk-lib` was bumped to the latest 2.x at the same time.

## Accepted and documented

These findings are intentional properties of a self-contained teaching sample.
Narrowing them further would either break a demonstrated behavior or introduce a
latent regression, so they are documented rather than "fixed". They would change
in a production posture.

- **IAM — `bedrock:InvokeModel` region wildcard (high).** The foundation-model ARN
  keeps `arn:aws:bedrock:*::foundation-model/${baseModelId}`. Cross-region
  inference profiles (the default `us.`/`eu.`/`apac.`/`global.` model IDs) fan a
  single call out to the model in *several* regions; pinning the region here
  would deny legitimate inference for the default configuration. The model id
  itself is scoped, and the inference-profile ARN is region- and account-scoped.
- **IAM — rate-limit custom resource `${gwArn}/*` (high).** Kept because gateway
  rate limits are addressed as sub-resources of the gateway ARN; the
  Create/Get/Update/Delete rate-limit calls operate on that sub-resource path.
- **IAM — gateway role `gateway/*` (medium).** The service validates
  `GetPolicyEngine`/`AuthorizeAction` at gateway-creation time, before the gateway
  ARN exists, so scoping to the exact ARN creates a circular dependency. Documented
  trade-off; a production build would add a name-prefix condition or refactor.
- **CVE — `brace-expansion` (high, GHSA-rgw5-rvv9-x895).** The vulnerable copy is
  a **bundled** dependency inside `aws-cdk-lib` (latest 2.x still ships 5.0.8;
  the advisory requires >=5.0.9), so neither `npm audit fix` nor `overrides` can
  replace it — the fix has to come from the CDK release. It is deploy-time
  tooling that globs the developer's own files, not deployed runtime. Revisit on
  the next `aws-cdk-lib` release.
- **CDK NAG — not wired.** No `NagReport.csv` because cdk-nag is not yet added to
  the app. Tracked as a production-hardening item in the threat model (M15).
- **Bandit blind-except suppressions (`# noqa: BLE001`).** The Lambda handlers
  catch broadly at the entry point to surface failures to the demo dashboard; the
  agent handler re-raises after recording. This is the intended observability
  behavior for the demo's event trajectory.

## Cross-references

- Design-level threats and controls: [`threat-model/README.md`](./threat-model/README.md)
- Full model (import into Threat Composer): [`threat-model/dogwood-gateway.tc.json`](./threat-model/dogwood-gateway.tc.json)
- Accepted-risk register (matches the "Accepted and documented" section above):
  see the threat-model README.
