# Comprehensive Threat Model Report

**Generated**: 2026-08-10 11:15:16
**Current Phase**: 1 - Business Context Analysis
**Overall Completion**: 90.0%

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Business Context](#business-context)
3. [System Architecture](#system-architecture)
4. [Threat Actors](#threat-actors)
5. [Trust Boundaries](#trust-boundaries)
6. [Assets and Flows](#assets-and-flows)
7. [Threats](#threats)
8. [Mitigations](#mitigations)
9. [Assumptions](#assumptions)
10. [Phase Progress](#phase-progress)

## Executive Summary

Educational security demonstration ("Dogwood Gateway" / "AgentCore Gateway + Dogwood"). A public AWS sample that shows temporal authorization policies (Dogwood language) and rate limiting enforced at Amazon Bedrock AgentCore Gateway. A real LLM agent (Bedrock Converse tool-use loop) calls synthetic banking/trading tools through the gateway; every call crosses a policy engine that enforces session-aware Dogwood policies (output-to-input integrity, cumulative budget, one-time-use approvals) plus gateway rate limits. A React dashboard visualizes each tool call and the gateway's verdict. Intended to be deployed to a sandbox account, demonstrated, and torn down. All banking/trading data is synthetic and hardcoded; no real funds, customers, or PII exist. Not a production system.

### Key Statistics

- **Total Threats**: 14
- **Total Mitigations**: 16
- **Total Assumptions**: 0
- **System Components**: 11
- **Assets**: 13
- **Threat Actors**: 12

## Business Context

**Description**: Educational security demonstration ("Dogwood Gateway" / "AgentCore Gateway + Dogwood"). A public AWS sample that shows temporal authorization policies (Dogwood language) and rate limiting enforced at Amazon Bedrock AgentCore Gateway. A real LLM agent (Bedrock Converse tool-use loop) calls synthetic banking/trading tools through the gateway; every call crosses a policy engine that enforces session-aware Dogwood policies (output-to-input integrity, cumulative budget, one-time-use approvals) plus gateway rate limits. A React dashboard visualizes each tool call and the gateway's verdict. Intended to be deployed to a sandbox account, demonstrated, and torn down. All banking/trading data is synthetic and hardcoded; no real funds, customers, or PII exist. Not a production system.

### Business Features

- **Industry Sector**: Technology
- **Data Sensitivity**: Public
- **User Base Size**: Small
- **Geographic Scope**: Global
- **Regulatory Requirements**: None
- **System Criticality**: Low
- **Financial Impact**: Minimal
- **Authentication Requirement**: Federated
- **Deployment Environment**: Cloud-Public
- **Integration Complexity**: Moderate

## System Architecture

### Components

| ID | Name | Type | Service Provider | Description |
|---|---|---|---|---|
| C001 | Dashboard (CloudFront + S3) | Network | AWS | Static React SPA served by CloudFront over HTTPS from a private S3 bucket (Origin Access Control). Public static assets; all data/actions live behind the authenticated API. Runtime config.json carries apiUrl, Cognito domain, and client id. |
| C002 | Demo API (HTTP API) | Network | AWS | HTTP API with a JWT authorizer bound to the Cognito user pool. Routes: GET /config, POST /run, GET /events, POST /mode. CORS allowOrigins '*'. |
| C003 | API Lambda | Compute | AWS | Control-plane for the demo. Starts acts (invokes AgentFn async), polls events from DynamoDB, and flips the gateway policy-engine mode (GetGateway/UpdateGateway). Bundled boto3. |
| C004 | Agent Lambda | Compute | AWS | Demo agent. Runs a Bedrock Converse tool-use loop and calls banking tools through the gateway MCP endpoint using SigV4. Records every tool call, verdict, and token count to DynamoDB. Also runs scripted concurrent burst for the rate-limit act. |
| C005 | AgentCore Gateway | Network | AWS | Serverless MCP entry point (AWS_IAM inbound auth, exceptionLevel DEBUG). Routes tools/call to the Lambda target. Enforces the attached policy engine (ENFORCE) and gateway rate limits before dispatch. |
| C006 | Policy Engine (Cedar + Dogwood) | Security | AWS | Cedar + Dogwood temporal policies. 5 plain permits + 5 temporal policies (TransferRequiresLookup, SessionBudgetCap, TradeRequiresUnusedApproval, TradeOneAttemptPerApproval, TaintedSessionNoTransfer). Deny-by-default; enforced at the gateway outside agent code. |
| C007 | BankTools Lambda (gateway target) | Compute | AWS | Synthetic banking/trading tools behind the gateway: get_account_balance, transfer_funds, purchase_item, get_market_news (intentionally fails), approve_trade, execute_trade. All data hardcoded/synthetic. Invoked by the gateway via GATEWAY_IAM_ROLE credential provider. |
| C008 | Events Table | Storage | AWS | Trajectory event store (partition runId, sort seq), on-demand billing, TTL expireAt (24h). Holds prompts, tool calls, verdicts, token counts. Written by AgentFn, read by ApiFn. |
| C009 | Rate Limit Custom Resource | Compute | AWS | CDK custom resource that calls Create/Update/DeleteGatewayRateLimit (no CFN resource exists). installLatestAwsSdk. Configures 1 req/s on get_market_news tool, 300/min wildcard. |
| C010 | Cognito User Pool | Security | AWS | Email+password user pool. Self sign-up disabled; first user created by deploy.sh via admin-create-user. Hosted UI (classic) with authorization-code + PKCE. Issues JWT access/id tokens that guard the demo API. |
| C011 | Bedrock (Claude) | Serverless | AWS | Foundation model backing the agent's tool-use loop. Default us.anthropic.claude-sonnet-4-5 inference profile. Invoked by the Agent Lambda via the Converse API. |

### Connections

| ID | Source | Destination | Protocol | Port | Encrypted | Description |
|---|---|---|---|---|---|---|
| CN001 | C001 | C010 | HTTPS | 443 | Yes | Browser -> Cognito Hosted UI: OAuth2 authorization-code + PKCE login |
| CN002 | C001 | C002 | HTTPS | 443 | Yes | Dashboard -> Demo API with Bearer JWT access token |
| CN003 | C002 | C010 | HTTPS | 443 | Yes | HTTP API JWT authorizer validates tokens against Cognito JWKS/issuer |
| CN004 | C002 | C003 | HTTPS | 443 | Yes | HTTP API -> API Lambda proxy integration |
| CN005 | C003 | C004 | HTTPS | 443 | Yes | API Lambda -> Agent Lambda async invoke (InvocationType Event) |
| CN006 | C003 | C008 | HTTPS | 443 | Yes | API Lambda reads trajectory events from DynamoDB |
| CN007 | C003 | C005 | HTTPS | 443 | Yes | API Lambda -> AgentCore control plane (GetGateway/UpdateGateway to flip policy mode) |
| CN008 | C004 | C011 | HTTPS | 443 | Yes | Agent Lambda -> Bedrock Converse (model tool-use loop) |
| CN009 | C004 | C005 | HTTPS | 443 | Yes | Agent Lambda -> Gateway MCP endpoint: SigV4-signed tools/call with x-amzn-bedrock-agentcore-policy-session-id header |
| CN010 | C004 | C008 | HTTPS | 443 | Yes | Agent Lambda writes prompts, tool calls, verdicts, token counts to DynamoDB |
| CN011 | C005 | C006 | HTTPS | 443 | Yes | Gateway -> Policy Engine: AuthorizeAction / PartiallyAuthorizeActions per tool call |
| CN012 | C005 | C007 | HTTPS | 443 | Yes | Gateway -> BankTools Lambda invoke via GATEWAY_IAM_ROLE credential provider |
| CN013 | C009 | C005 | HTTPS | 443 | Yes | CDK custom resource -> AgentCore control plane: Create/Update/DeleteGatewayRateLimit |

### Data Stores

| ID | Name | Type | Classification | Encrypted at Rest | Description |
|---|---|---|---|---|---|
| D001 | Events Table (DynamoDB) | NoSQL | Public | Yes | Trajectory events: prompts, tool calls, arguments, gateway verdicts, token counts. Synthetic demo data only. TTL 24h. |
| D002 | Dashboard bucket (S3) | Object Storage | Public | Yes | Static SPA assets plus runtime config.json (non-secret: apiUrl, Cognito domain, public client id). Private bucket, CloudFront OAC only. |
| D003 | Session trajectory (Policy engine state) | Other | Public | Yes | Session-scoped agent trajectory held by Policy in AgentCore for temporal evaluation. Keyed by session id + caller identity. Max 24h look-back; invalidated on policy change. Synthetic tool inputs/outputs. |
| D004 | Cognito user directory | Other | Confidential | Yes | Demo user identities (email + password hash) for dashboard sign-in, managed by Amazon Cognito. Operator email(s) only; no end-customer PII. Self sign-up disabled. |

## Threat Actors

### Insider

- **Type**: ThreatActorType.INSIDER
- **Capability Level**: CapabilityLevel.MEDIUM
- **Motivations**: Financial, Revenge
- **Resources**: ResourceLevel.LIMITED
- **Relevant**: Yes
- **Priority**: 5/10
- **Description**: An employee or contractor with legitimate access to the system

### External Attacker

- **Type**: ThreatActorType.EXTERNAL
- **Capability Level**: CapabilityLevel.MEDIUM
- **Motivations**: Financial
- **Resources**: ResourceLevel.MODERATE
- **Relevant**: Yes
- **Priority**: 2/10
- **Description**: An external individual or group attempting to gain unauthorized access

### Nation-state Actor

- **Type**: ThreatActorType.NATION_STATE
- **Capability Level**: CapabilityLevel.HIGH
- **Motivations**: Espionage, Political
- **Resources**: ResourceLevel.EXTENSIVE
- **Relevant**: No
- **Priority**: 10/10
- **Description**: A government-sponsored group with advanced capabilities

### Hacktivist

- **Type**: ThreatActorType.HACKTIVIST
- **Capability Level**: CapabilityLevel.MEDIUM
- **Motivations**: Ideology, Political
- **Resources**: ResourceLevel.MODERATE
- **Relevant**: Yes
- **Priority**: 8/10
- **Description**: An individual or group motivated by ideological or political beliefs

### Organized Crime

- **Type**: ThreatActorType.ORGANIZED_CRIME
- **Capability Level**: CapabilityLevel.HIGH
- **Motivations**: Financial
- **Resources**: ResourceLevel.EXTENSIVE
- **Relevant**: No
- **Priority**: 9/10
- **Description**: A criminal organization with significant resources

### Competitor

- **Type**: ThreatActorType.COMPETITOR
- **Capability Level**: CapabilityLevel.MEDIUM
- **Motivations**: Financial, Espionage
- **Resources**: ResourceLevel.MODERATE
- **Relevant**: No
- **Priority**: 7/10
- **Description**: A business competitor seeking competitive advantage

### Script Kiddie

- **Type**: ThreatActorType.SCRIPT_KIDDIE
- **Capability Level**: CapabilityLevel.LOW
- **Motivations**: Curiosity, Reputation
- **Resources**: ResourceLevel.LIMITED
- **Relevant**: Yes
- **Priority**: 3/10
- **Description**: An inexperienced attacker using pre-made tools

### Disgruntled Employee

- **Type**: ThreatActorType.DISGRUNTLED_EMPLOYEE
- **Capability Level**: CapabilityLevel.MEDIUM
- **Motivations**: Revenge
- **Resources**: ResourceLevel.LIMITED
- **Relevant**: Yes
- **Priority**: 4/10
- **Description**: A current or former employee with a grievance

### Privileged User

- **Type**: ThreatActorType.PRIVILEGED_USER
- **Capability Level**: CapabilityLevel.HIGH
- **Motivations**: Financial, Accidental
- **Resources**: ResourceLevel.MODERATE
- **Relevant**: Yes
- **Priority**: 8/10
- **Description**: A user with elevated privileges who may abuse them or make mistakes

### Third Party

- **Type**: ThreatActorType.THIRD_PARTY
- **Capability Level**: CapabilityLevel.MEDIUM
- **Motivations**: Financial, Accidental
- **Resources**: ResourceLevel.MODERATE
- **Relevant**: No
- **Priority**: 10/10
- **Description**: A vendor, partner, or service provider with access to the system

### Authenticated Dashboard Operator

- **Type**: ThreatActorType.PRIVILEGED_USER
- **Capability Level**: CapabilityLevel.MEDIUM
- **Motivations**: Curiosity, Accidental
- **Resources**: ResourceLevel.MODERATE
- **Relevant**: Yes
- **Priority**: 4/10
- **Description**: A person with valid Cognito credentials to the demo dashboard. Can start acts and flip the policy-engine enforcement mode (ENFORCE <-> LOG_ONLY) via the API. Trusted, but could leave the engine in LOG_ONLY or share the dashboard URL.

### Authenticated Dashboard Operator

- **Type**: ThreatActorType.PRIVILEGED_USER
- **Capability Level**: CapabilityLevel.MEDIUM
- **Motivations**: Curiosity, Accidental
- **Resources**: ResourceLevel.MODERATE
- **Relevant**: Yes
- **Priority**: 5/10
- **Description**: A person with valid Cognito credentials to the demo dashboard. Can start acts and flip the policy-engine enforcement mode (ENFORCE <-> LOG_ONLY) via the API. Trusted, but could leave the engine in LOG_ONLY or share the dashboard URL.

## Trust Boundaries

### Trust Zones

#### Internet

- **Trust Level**: TrustLevel.UNTRUSTED
- **Description**: The public internet, considered untrusted

#### DMZ

- **Trust Level**: TrustLevel.LOW
- **Description**: Demilitarized zone for public-facing services

#### Application

- **Trust Level**: TrustLevel.MEDIUM
- **Description**: Zone containing application servers and services

#### Data

- **Trust Level**: TrustLevel.HIGH
- **Description**: Zone containing databases and data storage

#### Admin

- **Trust Level**: TrustLevel.FULL
- **Description**: Administrative zone with highest privileges

#### Untrusted Internet

- **Trust Level**: TrustLevel.UNTRUSTED
- **Description**: The public internet and the operator's browser before authentication.

#### Public Edge

- **Trust Level**: TrustLevel.LOW
- **Description**: Public-facing managed edge: CloudFront/S3 static dashboard and the Cognito Hosted UI. Serves public assets and handles sign-in.

#### Demo Control Plane

- **Trust Level**: TrustLevel.MEDIUM
- **Description**: Authenticated application tier: HTTP API (JWT-guarded), API Lambda, Agent Lambda, Events DynamoDB, and the rate-limit custom resource.

#### AgentCore Enforcement Perimeter

- **Trust Level**: TrustLevel.HIGH
- **Description**: The gateway and its policy engine: the deny-by-default choke point where every tool call is authorized (Cedar + Dogwood) and rate-limited, outside the agent's code.

#### Tool & Model Backend

- **Trust Level**: TrustLevel.MEDIUM
- **Description**: Downstream resources the agent consumes: the BankTools Lambda (synthetic tools) reached only via the gateway, and Bedrock for inference.

### Trust Boundaries

#### Internet Boundary

- **Type**: BoundaryType.NETWORK
- **Controls**: Web Application Firewall, DDoS Protection, TLS Encryption
- **Description**: Boundary between the internet and internal systems

#### DMZ Boundary

- **Type**: BoundaryType.NETWORK
- **Controls**: Network Firewall, Intrusion Detection System, API Gateway
- **Description**: Boundary between public-facing services and internal applications

#### Data Boundary

- **Type**: BoundaryType.NETWORK
- **Controls**: Database Firewall, Encryption, Access Control Lists
- **Description**: Boundary protecting data storage systems

#### Admin Boundary

- **Type**: BoundaryType.NETWORK
- **Controls**: Privileged Access Management, Multi-Factor Authentication, Audit Logging
- **Description**: Boundary for administrative access

#### Internet edge (CloudFront + Cognito)

- **Type**: BoundaryType.NETWORK
- **Controls**: HTTPS/TLS, CloudFront, Cognito Hosted UI, PKCE, Self sign-up disabled
- **Description**: Boundary between the untrusted internet and the public managed edge.

#### API authentication boundary (JWT)

- **Type**: BoundaryType.PROCESS
- **Controls**: Cognito user pool, API Gateway JWT authorizer, TLS, CORS
- **Description**: Every demo API route requires a valid Cognito JWT; unauthenticated requests are rejected before reaching Lambda.

#### AgentCore Gateway enforcement boundary

- **Type**: BoundaryType.PROCESS
- **Controls**: AWS_IAM inbound auth (SigV4), Cedar + Dogwood policy engine (ENFORCE, deny-by-default), Temporal policies, Gateway rate limits, Policy session id + caller identity
- **Description**: The central control: every tool call is authenticated by IAM, authorized by the policy engine against the session trajectory, and rate-limited, outside the agent's code. Rate limits are fail-open (traffic management, not a security boundary).

#### Inference boundary (Bedrock)

- **Type**: BoundaryType.PROCESS
- **Controls**: IAM scoped to model ARNs, TLS
- **Description**: Agent-to-model calls; scoped IAM permissions on bedrock:InvokeModel.

## Assets and Flows

### Assets

| ID | Name | Type | Classification | Sensitivity | Criticality | Owner |
|---|---|---|---|---|---|---|
| A001 | User Credentials | AssetType.CREDENTIAL | AssetClassification.CONFIDENTIAL | 5 | 5 | N/A |
| A002 | Personal Identifiable Information | AssetType.DATA | AssetClassification.CONFIDENTIAL | 4 | 4 | N/A |
| A003 | Session Token | AssetType.TOKEN | AssetClassification.CONFIDENTIAL | 5 | 5 | N/A |
| A004 | Configuration Data | AssetType.CONFIG | AssetClassification.INTERNAL | 3 | 4 | N/A |
| A005 | Encryption Keys | AssetType.KEY | AssetClassification.RESTRICTED | 5 | 5 | N/A |
| A006 | Public Content | AssetType.DATA | AssetClassification.PUBLIC | 1 | 2 | N/A |
| A007 | Audit Logs | AssetType.DATA | AssetClassification.INTERNAL | 3 | 4 | N/A |
| A008 | Cognito credentials & JWT tokens | AssetType.CREDENTIAL | AssetClassification.CONFIDENTIAL | 4 | 4 | Operator |
| A009 | Policy enforcement mode (ENFORCE/LOG_ONLY) | AssetType.CONFIG | AssetClassification.INTERNAL | 3 | 5 | Operator |
| A010 | Session trajectory / event history | AssetType.DATA | AssetClassification.PUBLIC | 2 | 4 | System |
| A011 | Gateway invoke capability (SigV4/IAM) | AssetType.CREDENTIAL | AssetClassification.CONFIDENTIAL | 4 | 4 | System |
| A012 | Bedrock model access / token budget | AssetType.DATA | AssetClassification.INTERNAL | 2 | 3 | System |
| A013 | Synthetic banking/trading tool data | AssetType.DATA | AssetClassification.PUBLIC | 1 | 1 | System |

### Asset Flows

| ID | Asset | Source | Destination | Protocol | Encrypted | Risk Level |
|---|---|---|---|---|---|---|
| F001 | User Credentials | C001 | C002 | HTTPS | Yes | 4 |
| F002 | Session Token | C002 | C001 | HTTPS | Yes | 3 |
| F003 | Personal Identifiable Information | C003 | C004 | TLS | Yes | 3 |
| F004 | Audit Logs | C003 | C005 | TLS | Yes | 2 |
| F005 | Cognito credentials & JWT tokens | C010 | C001 | HTTPS | Yes | 2 |
| F006 | Policy enforcement mode (ENFORCE/LOG_ONLY) | C003 | C005 | HTTPS | Yes | 3 |
| F007 | Session trajectory / event history | C004 | C008 | HTTPS | Yes | 2 |
| F008 | Gateway invoke capability (SigV4/IAM) | C004 | C005 | HTTPS | Yes | 2 |
| F009 | Bedrock model access / token budget | C004 | C011 | HTTPS | Yes | 3 |

## Threats

### Identified Threats

#### T1: An unauthenticated internet user who discovered the CloudFront/API URL

**Statement**: A An unauthenticated internet user who discovered the CloudFront/API URL network access to the public API endpoint, no valid token can call demo API routes (/run, /mode, /events) without a Cognito JWT, which leads to unauthorized control of the demo and its Bedrock/gateway spend

- **Prerequisites**: network access to the public API endpoint, no valid token
- **Action**: call demo API routes (/run, /mode, /events) without a Cognito JWT
- **Impact**: unauthorized control of the demo and its Bedrock/gateway spend
- **Impacted Assets**: A008, A009
- **Tags**: STRIDE-S, auth

#### T2: An external actor with the public Cognito client id and hosted-UI URL

**Statement**: A An external actor with the public Cognito client id and hosted-UI URL knowledge of the user pool hosted UI (client id is public in config.json) can self-register a new account to obtain a valid JWT, which leads to bypass of the intended allowlist of operators

- **Prerequisites**: knowledge of the user pool hosted UI (client id is public in config.json)
- **Action**: self-register a new account to obtain a valid JWT
- **Impact**: bypass of the intended allowlist of operators
- **Impacted Assets**: A008
- **Tags**: STRIDE-S, auth

#### T3: A manipulated agent (prompt injection in a user message or tool output)

**Statement**: A A manipulated agent (prompt injection in a user message or tool output) attacker-controlled text reaches the model; agent holds valid gateway credentials can call transfer_funds with a fabricated destination account never returned by a lookup, which leads to funds routed to an attacker account (in a real deployment)

- **Prerequisites**: attacker-controlled text reaches the model; agent holds valid gateway credentials
- **Action**: call transfer_funds with a fabricated destination account never returned by a lookup
- **Impact**: funds routed to an attacker account (in a real deployment)
- **Impacted Assets**: A013
- **Tags**: STRIDE-T, agent, core-demo

#### T4: A runaway or manipulated agent

**Statement**: A A runaway or manipulated agent agent can issue many tool calls in a session can salami-slice many sub-threshold purchases to exceed the intended session budget, which leads to cumulative financial exposure beyond what any single approval allowed

- **Prerequisites**: agent can issue many tool calls in a session
- **Action**: salami-slice many sub-threshold purchases to exceed the intended session budget
- **Impact**: cumulative financial exposure beyond what any single approval allowed
- **Impacted Assets**: A013
- **Tags**: STRIDE-T, agent, core-demo

#### T5: A manipulated agent reusing a standing approval

**Statement**: A A manipulated agent reusing a standing approval one approval event exists in the session trajectory can execute the same trade multiple times against a single one-time approval, which leads to approval replay multiplies exposure a human signed off once

- **Prerequisites**: one approval event exists in the session trajectory
- **Action**: execute the same trade multiple times against a single one-time approval
- **Impact**: approval replay multiplies exposure a human signed off once
- **Impacted Assets**: A013
- **Tags**: STRIDE-T, agent, core-demo

#### T6: A caller who controls their own policy-session id

**Statement**: A A caller who controls their own policy-session id ability to set the x-amzn-bedrock-agentcore-policy-session-id header can start a fresh session to reset session-scoped counters (budget, rate, approvals), which leads to session-scoped temporal controls do not bound a determined caller

- **Prerequisites**: ability to set the x-amzn-bedrock-agentcore-policy-session-id header
- **Action**: start a fresh session to reset session-scoped counters (budget, rate, approvals)
- **Impact**: session-scoped temporal controls do not bound a determined caller
- **Impacted Assets**: A010
- **Tags**: STRIDE-T, limitation

#### T7: Any operator with dashboard access

**Statement**: A Any operator with dashboard access valid Cognito JWT can flip the policy engine to LOG_ONLY and leave it there, which leads to all temporal enforcement silently becomes observe-only; denials stop

- **Prerequisites**: valid Cognito JWT
- **Action**: flip the policy engine to LOG_ONLY and leave it there
- **Impact**: all temporal enforcement silently becomes observe-only; denials stop
- **Impacted Assets**: A009
- **Tags**: STRIDE-E, demo-feature

#### T8: A runaway agent hitting a failing tool

**Statement**: A A runaway agent hitting a failing tool a tool that errors and an agent that retries can flood the gateway with tool calls, or drive heavy Bedrock token/connection use, which leads to cost blow-up and starvation of other traffic

- **Prerequisites**: a tool that errors and an agent that retries
- **Action**: flood the gateway with tool calls, or drive heavy Bedrock token/connection use
- **Impact**: cost blow-up and starvation of other traffic
- **Impacted Assets**: A012
- **Tags**: STRIDE-D, cost, core-demo

#### T9: Cost/DoS via the direct inference path

**Statement**: A Cost/DoS via the direct inference path agent invokes Bedrock directly (not through the gateway) can consume Bedrock tokens in a long tool-use loop, which leads to Bedrock spend not bounded by any gateway rate limit

- **Prerequisites**: agent invokes Bedrock directly (not through the gateway)
- **Action**: consume Bedrock tokens in a long tool-use loop
- **Impact**: Bedrock spend not bounded by any gateway rate limit
- **Impacted Assets**: A012
- **Tags**: STRIDE-D, cost

#### T10: An operator or auditor investigating an incident

**Statement**: A An operator or auditor investigating an incident no per-operator audit trail for who flipped mode or ran acts can deny having disabled enforcement or triggered an action, which leads to actions on the enforcement mode and runs are not attributable

- **Prerequisites**: no per-operator audit trail for who flipped mode or ran acts
- **Action**: deny having disabled enforcement or triggered an action
- **Impact**: actions on the enforcement mode and runs are not attributable
- **Impacted Assets**: A009
- **Tags**: STRIDE-R, observability

#### T11: An observer of gateway error payloads

**Statement**: A An observer of gateway error payloads gateway exceptionLevel DEBUG surfaces denial reasons verbatim can read policy denial details returned in MCP error responses, which leads to policy structure/logic disclosed (intended for the demo UI, risky in prod)

- **Prerequisites**: gateway exceptionLevel DEBUG surfaces denial reasons verbatim
- **Action**: read policy denial details returned in MCP error responses
- **Impact**: policy structure/logic disclosed (intended for the demo UI, risky in prod)
- **Impacted Assets**: A010
- **Tags**: STRIDE-I, demo-feature

#### T12: An attacker probing IAM blast radius

**Statement**: A An attacker probing IAM blast radius compromise of the Agent Lambda execution role can invoke any Bedrock foundation model / inference profile via the broad InvokeModel grant, which leads to wider model access and cost than the demo needs

- **Prerequisites**: compromise of the Agent Lambda execution role
- **Action**: invoke any Bedrock foundation model / inference profile via the broad InvokeModel grant
- **Impact**: wider model access and cost than the demo needs
- **Impacted Assets**: A012
- **Tags**: STRIDE-E, iam, least-privilege

#### T13: An attacker with a foothold in the browser (XSS)

**Statement**: A An attacker with a foothold in the browser (XSS) an XSS sink in the SPA (none obvious; React, no dangerouslySetInnerHTML) can read the JWT access token from sessionStorage, which leads to token theft and demo-API impersonation until token expiry

- **Prerequisites**: an XSS sink in the SPA (none obvious; React, no dangerouslySetInnerHTML)
- **Action**: read the JWT access token from sessionStorage
- **Impact**: token theft and demo-API impersonation until token expiry
- **Impacted Assets**: A008
- **Tags**: STRIDE-I, frontend

#### T14: A supply-chain or dependency risk

**Statement**: A A supply-chain or dependency risk npm (CDK/frontend) and boto3 dependencies pulled at build can introduce a malicious or vulnerable transitive dependency, which leads to compromise of build/deploy or the running Lambdas

- **Prerequisites**: npm (CDK/frontend) and boto3 dependencies pulled at build
- **Action**: introduce a malicious or vulnerable transitive dependency
- **Impact**: compromise of build/deploy or the running Lambdas
- **Impacted Assets**: A011
- **Tags**: STRIDE-T, supply-chain

## Mitigations

### Resolved Mitigations

#### M1: API Gateway JWT authorizer on every route (/config,/run,/events,/mode) validates a Cognito access token; unauthenticated requests are rejected before Lambda. Verified in the smoke test (401).

**Addresses Threats**: T1

#### M2: Cognito self sign-up disabled; the first operator is created by deploy.sh via admin-create-user; preventUserExistenceErrors enabled. Additional users only via admin action.

**Addresses Threats**: T2

#### M3: Dogwood policy TransferRequiresLookup (output-to-input integrity): transfer_funds permitted only when a prior get_account_balance response in-session returned the destination account.

**Addresses Threats**: T3

#### M16: Dogwood policy TaintedSessionNoTransfer (forbid + formerly): once a read_market_research response exists in the session, transfer_funds is forbidden for the rest of the session. A forbid overrides every permit, so prompt-injection containment holds even for transfers that satisfy TransferRequiresLookup, and regardless of whether the injection fooled the model. Demonstrated in Act 6.

**Addresses Threats**: T3

#### M4: Dogwood policy SessionBudgetCap (sum aggregation): forbids purchase_item once the session's cumulative amount exceeds the budget, including the current request.

**Addresses Threats**: T4

#### M5: Dogwood policies TradeRequiresUnusedApproval (negated-left since) and TradeOneAttemptPerApproval (anchored count + bind): a trade is permitted only while no completed trade has occurred since a matching approval for the exact ticker and quantity, and a forbid counts execution attempts (including in-flight requests) since the last matching approval, so concurrent double-execution against one approval is denied. Verified against the Dogwood reference interpreter (race trace and act 5 sequence).

**Addresses Threats**: T5

#### M6: Policy engine runs ENFORCE, deny-by-default, at the gateway outside agent code; the agent cannot see or reason around the policies. Enforced on every tools/call.

**Addresses Threats**: T3, T4, T5

#### M7: Gateway rate limit (1 req/s on the failing tool, 300/min wildcard) plus per-invocation Lambda timeout and a hard tool-call budget in the agent bound runaway consumption.

**Addresses Threats**: T8, T9

#### M8: Transport & storage hardening: private S3 with CloudFront Origin Access Control, enforceSSL, TLS everywhere, DynamoDB encryption at rest with 24h TTL, synthetic data only.

**Addresses Threats**: T13, T1

#### M9: iam:PassRole for the gateway role is constrained with a PassedToService condition (bedrock-agentcore.amazonaws.com); gateway role invoke is scoped to the BankTools function ARN.

**Addresses Threats**: T12

#### M10: Scope the Agent Lambda's bedrock:InvokeModel to the configured model ARNs (specific inference profile + that model's foundation-model ARN) instead of foundation-model/* and inference-profile/*.

**Addresses Threats**: T9, T12

### Identified Mitigations

#### M11: RECOMMENDED for production: enable AgentCore Gateway application logs (OTEL) and API Gateway access logs to attribute mode flips and runs; the demo relies on CloudTrail only.

**Addresses Threats**: T7, T10

#### M12: ACCEPTED for demo / documented: gateway exceptionLevel is DEBUG so the dashboard can show denial reasons verbatim. In production use a less verbose level to avoid disclosing policy structure.

**Addresses Threats**: T11

#### M13: ACCEPTED for demo / documented: session-scoped temporal controls (budget, rate, approvals) shape behavior within a cooperative session; a caller controlling their own session id can reset counters. Not a hard boundary.

**Addresses Threats**: T6

#### M14: ACCEPTED for demo / documented: the LOG_ONLY toggle is an intentional teaching feature exposed through the authenticated API; it makes enforcement observe-only. Not present in a production posture.

**Addresses Threats**: T7

#### M15: RECOMMENDED / defense-in-depth: pin dependency versions and scan with CVE tooling; add SPDX/MIT-0 license headers; consider AWS WAF on CloudFront/API and cdk-nag suppressions with justifications for production.

**Addresses Threats**: T13, T14

## Assumptions

*No assumptions defined.*

## Phase Progress

| Phase | Name | Completion |
|---|---|---|
| 1 | Business Context Analysis | 100% ✅ |
| 2 | Architecture Analysis | 100% ✅ |
| 3 | Threat Actor Analysis | 100% ✅ |
| 4 | Trust Boundary Analysis | 100% ✅ |
| 5 | Asset Flow Analysis | 100% ✅ |
| 6 | Threat Identification | 100% ✅ |
| 7 | Mitigation Planning | 100% ✅ |
| 7.5 | Code Validation Analysis | 100% ✅ |
| 8 | Residual Risk Analysis | 0% ⏳ |
| 9 | Output Generation and Documentation | 100% ✅ |

---

*This threat model report was generated automatically by the Threat Modeling MCP Server.*
