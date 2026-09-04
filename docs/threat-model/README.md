<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. SPDX-License-Identifier: MIT-0 -->

# Threat model — AgentCore Gateway + Dogwood demo

This directory holds the threat model for the demo, produced with the AWS threat
modeling methodology (business context → architecture → threat actors → trust
boundaries → asset flows → STRIDE threats → mitigations → residual risk).

## Artifacts

| File | What it is |
| --- | --- |
| [`dogwood-gateway.tc.json`](dogwood-gateway.tc.json) | Threat Composer JSON (schema 1). Import at <https://awslabs.github.io/threat-composer/> |
| [`dogwood-gateway.md`](dogwood-gateway.md) | Human-readable report of the same model |
| [`../security-scan.md`](../security-scan.md) | Automated code/IaC/dependency scan summary + remediation |

The model covers 11 components, 5 trust zones / 4 trust boundaries, 13 assets,
14 STRIDE threats, and 16 mitigations. Every threat is linked to at least one
mitigation.

## The system in one paragraph

An LLM agent (Bedrock Converse tool-use loop) calls synthetic banking/trading
tools through an Amazon Bedrock AgentCore Gateway. Every tool call crosses a
Cedar + Dogwood policy engine (ENFORCE, deny-by-default) and gateway rate limits,
enforced **outside the agent's code**. A Cognito-authenticated React dashboard
starts scenarios and visualizes each verdict. All data is synthetic; the app is a
sandbox teaching sample, not a production system.

## The primary threat actor

Unlike a typical web app, the actor this system is built to contain is **the
agent itself** — hallucinating tool arguments, looping, or being steered by
prompt injection. Each individual call is authorized; the harm only appears in
the *sequence*. That is exactly what the temporal Dogwood policies address:

| Demo threat | Control |
| --- | --- |
| Fabricated transfer destination (hallucination) | `TransferRequiresLookup` — output-to-input integrity |
| Salami-slicing past a budget | `SessionBudgetCap` — `sum` aggregation |
| Approval replay (incl. concurrent double-execution) | `TradeRequiresUnusedApproval` — negated-left `since` + `TradeOneAttemptPerApproval` — anchored `count` + `bind` |
| Prompt injection via tool content (tainted session) | `TaintedSessionNoTransfer` — `forbid` + `formerly`: untrusted read forbids transfers session-wide |
| Runaway consumption | Gateway rate limit + Lambda timeout + tool-call budget |

## Key implemented controls

- Cognito user pool (self sign-up disabled) + API Gateway JWT authorizer on every
  route; unauthenticated calls are rejected before Lambda (verified in the smoke
  test).
- Policy engine in ENFORCE, deny-by-default, at the gateway.
- Private S3 + CloudFront Origin Access Control, TLS everywhere, DynamoDB
  encryption at rest with a 24h TTL, synthetic data only.
- `iam:PassRole` for the gateway role constrained with a `PassedToService`
  condition; gateway invoke scoped to the tools function ARN.
- **Least-privilege model access**: the agent's `bedrock:InvokeModel` is scoped to
  the configured model's foundation-model and inference-profile ARNs, not `*`.

## Accepted risks (intentional for a teaching demo)

These are deliberate properties of a demonstration and are documented rather than
"fixed". They would change in a production posture.

- **`LOG_ONLY` toggle.** The dashboard can flip the policy engine to observe-only
  through the authenticated API. This is the teaching finale of the demo, not a
  production control.
- **Gateway `exceptionLevel: DEBUG`.** Denial reasons are returned verbatim so the
  dashboard can show *why* a call was blocked. In production use a less verbose
  level to avoid disclosing policy structure.
- **Session-scoped controls.** Budget, rate, and approval controls are scoped to a
  policy session; a caller who controls their own session id can reset counters.
  They shape behavior within a cooperative session and are not a hard boundary
  against a determined caller. (See the AgentCore temporal-policy security
  considerations.)
- **Public dashboard assets + CORS `*`.** The static SPA is served publicly by
  CloudFront and the API allows any origin, because the API is guarded by a
  Bearer JWT (not cookies), so CSRF/origin is not the control. All data and
  actions live behind the authenticated API.
- **`installLatestAwsSdk` on the rate-limit custom resource.** Required because no
  CloudFormation resource exists for gateway rate limits and the bundled Lambda
  SDK predates the API; pinned SDK is a production hardening item.

## Recommended for a production adaptation

- Enable AgentCore Gateway application logs (OTEL) and API Gateway access logs for
  attribution of mode flips and runs.
- Add AWS WAF on CloudFront/API and cdk-nag suppressions with justifications.
- Pin dependency versions and run CVE scanning in CI.
