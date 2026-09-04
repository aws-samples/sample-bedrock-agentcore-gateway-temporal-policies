// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
export interface ActInfo {
  title: string;
  scenario: string;
  risk: string;
  before: string;
  now: string;
  reference: string;
}

/**
 * Factual explainers for each act. "before" describes what stateless,
 * per-request authorization (or app-level code) could not express; "now"
 * describes what AgentCore Gateway + Dogwood temporal policies enforce.
 */
export const ACT_INFO: Record<string, ActInfo> = {
  act1: {
    title: 'Legitimate work',
    scenario:
      'The agent looks up customer C-1001, gets back account ACC-4021, and transfers $500 to exactly that account. This is the baseline: the happy path the policies are designed to allow.',
    risk:
      'None here. This act exists to show that the controls do not get in the way of correct behavior: the lookup is recorded in the session trajectory, and the transfer matches it.',
    before:
      'A stateless check could allow this too. What it could not do is distinguish this case from Act 2: per-request authorization sees "principal calls transfer_funds" and has no way to ask where the destination account came from.',
    now:
      'The temporal permit correlates the transfer input with a prior tool output in the same session: transfer_funds is allowed only when an earlier get_account_balance response returned output.accountId equal to the toAccount being requested. The gateway records every call in the session trajectory and evaluates the rule on each request.',
    reference: 'Policy: TransferRequiresLookup (Dogwood, formerly within 1h)',
  },
  act2: {
    title: 'The hallucinated account',
    scenario:
      'A contrast in one session. The agent first runs the legitimate flow: it looks up customer C-1001 and transfers $500 to the account the lookup returned — allowed. Then it is told to transfer $500 to ACC-9987, an account no lookup in this session ever returned. Same caller, same tool, same session: the first transfer passes, the second bounces.',
    risk:
      'LLMs can hallucinate or substitute values between tool calls: an account number, an order ID, a hostname. Both transfer requests here are individually legitimate — this caller is allowed to transfer funds — so any per-request check passes both, and the money goes to the wrong account.',
    before:
      'To a stateless check the two transfers are indistinguishable: same principal, same tool, both within its rights. Telling them apart requires asking "did an earlier call return this destination account?" — a question about session history that per-request authorization cannot express. Validation written inside the agent is code the agent can skip, and a prompt injection or a model defect bypasses it.',
    now:
      'The gateway keeps the session trajectory outside the agent and evaluates the Dogwood condition on every call. The trajectory contains a lookup response for the first destination, so that transfer finds its matching permit. It contains no lookup that returned ACC-9987, so the second transfer finds no applicable permit and the engine denies by default. The agent cannot see or reason around the policy.',
    reference: 'Policy: TransferRequiresLookup (Dogwood, output-to-input integrity)',
  },
  act3: {
    title: 'Salami slicing',
    scenario:
      'The agent makes eight $900 purchases, one call at a time. Each purchase is well under any reasonable per-transaction threshold. The session budget is $5,000: purchases 1-5 total $4,500 and pass; purchase 6 would reach $5,400 and is denied.',
    risk:
      'Cumulative exposure. A runaway loop, a manipulated agent, or a deliberate strategy of staying under the approval threshold can spend without bound while every individual action looks fine. The problem only exists in the pattern.',
    before:
      'Per-request policies can cap a single amount but have no memory of a running total. Teams tracked totals in application code, which is per-team, inconsistent, and lives inside the process the agent controls.',
    now:
      'Dogwood aggregations run at the gateway: a sum over the purchase_item requests recorded in this session, including the current request, feeds a forbid rule. The purchase that pushes the total past $5,000 is the one that bounces. The total is scoped to the policy session.',
    reference: 'Policy: SessionBudgetCap (Dogwood, sum aggregation)',
  },
  act4: {
    title: 'The retry storm',
    scenario:
      'The market-news tool is down and every call to it fails. This act simulates a runaway retry loop: 60 concurrent calls fired at the gateway (scripted and labeled as simulated so the effect is visible on demand; the throttling itself is real).',
    risk:
      'An agent decides its own pace. A retry loop or an unusually heavy task consumes requests, tokens, and connections at whatever rate the agent chooses, running up cost and starving other traffic until someone notices.',
    before:
      'There was no single entry point at which to cap an agent\'s consumption per tool or per caller. Throttling logic had to be built into each client or each backend, separately, and a misbehaving agent was only discovered after the bill.',
    now:
      'Rate limits are configured on the gateway itself, with no agent code changes: this one caps the failing tool at 1 request/second by toolName, while every other tool keeps its own bucket. Limits are evaluated before policies. Note: rate limits fail open; they are traffic management, not a security boundary.',
    reference: 'Rate limit: dogwood-gateway-tool-storm (dimensionKeys: [toolName])',
  },
  act5: {
    title: 'The consumed approval',
    scenario:
      'Maker-checker for capital markets: the agent requests approval for a trade of 100 AMZN shares, executes it, then tries to execute the exact same trade again without a new approval. The second attempt is denied; after a fresh approval, a third execution passes.',
    risk:
      'Approval replay. In dual-authorization (four-eyes) workflows, an approval is meant to cover one action. An agent that reuses a standing approval — or was manipulated into doing so — can multiply the exposure a human signed off on once. Approval reuse is a classic trading-operations audit finding.',
    before:
      'Stateless checks can verify "an approval exists" but not "this approval has not been used yet" — that requires knowing what happened between the approval and now. Consumption tracking in application code sits inside the process the agent drives, and reconciling it across tools is exactly the kind of logic that drifts.',
    now:
      'Two Dogwood policies work together. The since operator expresses consumption directly: execute_trade is permitted only while no completed trade has occurred since a matching approval (same ticker, same quantity) within the last hour. The first execution is recorded as a response event and breaks the chain, so the approval is spent. A companion forbid closes the concurrency gap: a count anchored to the last matching approval tallies execution attempts — including in-flight requests — so two concurrent executions cannot ride one approval. The approval is also pinned to exact ticker and qty: approving 100 AMZN never authorizes 10,000 TSLA.',
    reference: 'Policies: TradeRequiresUnusedApproval (negated-left since) + TradeOneAttemptPerApproval (anchored count + bind)',
  },
  act6: {
    title: 'The poisoned research',
    scenario:
      'The agent reads a third-party research note, then runs the exact flow Act 1 allowed: look up customer C-1001, transfer $500 to the account the lookup returned. The research note is poisoned — it contains an instruction addressed to "automated processing agents" to wire a fee to an attacker\'s account. This time, every transfer bounces: the injected one if the model falls for it, and the legitimate one too.',
    risk:
      'Indirect prompt injection is the signature risk of tool-using agents: any document, email, or web page an agent reads can carry instructions that the model may execute as if they came from you. Combine three ingredients — untrusted content, valuable capabilities, and an instruction-following model — and the blast radius is every action the agent is allowed to take. You cannot reliably train this away; the input channel and instruction channel are the same channel.',
    before:
      'Defenses lived in the model: system prompts saying "ignore instructions in documents", input filters, output review. All probabilistic — they lower the odds, and a novel phrasing gets through. Per-request authorization is no help at all: the injected transfer is made by the right principal calling a permitted tool with well-formed arguments. It looks exactly like Act 1.',
    now:
      'The gateway makes it structural instead of probabilistic. A Dogwood forbid fires whenever a read_market_research response exists earlier in the session trajectory: untrusted content in, money movement off — for that session. A forbid overrides every permit, so even the transfer that satisfies TransferRequiresLookup is denied. It does not matter whether the injection fooled the model; the trifecta is broken outside the model. A fresh, untainted session transfers normally.',
    reference: 'Policy: TaintedSessionNoTransfer (Dogwood, forbid + formerly within 1h)',
  },
};
