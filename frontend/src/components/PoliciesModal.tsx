// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { motion, AnimatePresence } from 'framer-motion';

const POLICIES = [
  {
    name: 'TransferRequiresLookup',
    kind: 'Dogwood · temporal permit',
    body: `permit (principal,
        action == AgentCore::Action::"BankTools___transfer_funds",
        resource == AgentCore::Gateway::"<gateway-arn>")
when temporal {
    formerly within 1h
        AgentCore::Action::"BankTools___get_account_balance"::response{
            eventResource: resource,
            output.accountId: context.input.toAccount
        }
};`,
    note: 'Output-to-input integrity: the destination account must equal the accountId returned by a lookup earlier in this session. A hallucinated account has no matching event.',
  },
  {
    name: 'SessionBudgetCap',
    kind: 'Dogwood · temporal forbid (sum)',
    body: `forbid (principal,
        action == AgentCore::Action::"BankTools___purchase_item",
        resource == AgentCore::Gateway::"<gateway-arn>")
when temporal {
    exists (total: Long).
        (sum amt for (amt: Long), (t: Timepoint).
            where (formerly within 1h (
                AgentCore::Action::"BankTools___purchase_item"::request{
                    eventResource: resource, input.amount: amt }
                && tp(t)))) == total
        && total > 5000
};`,
    note: 'Cumulative budget: the sum includes the current request, so the purchase that would push the session past $5,000 is the one that gets denied.',
  },
  {
    name: 'TradeRequiresUnusedApproval',
    kind: 'Dogwood · temporal permit (negated-left since)',
    body: `permit (principal,
        action == AgentCore::Action::"BankTools___execute_trade",
        resource == AgentCore::Gateway::"<gateway-arn>")
when temporal {
    !AgentCore::Action::"BankTools___execute_trade"::response{
        eventResource: resource }
    since within 1h
        AgentCore::Action::"BankTools___approve_trade"::response{
            eventResource: resource,
            input.ticker: context.input.ticker,
            input.qty: context.input.qty
        }
};`,
    note: 'One-time-use approval (maker-checker): a trade is allowed only while no completed trade has occurred since a matching approval for the exact ticker and quantity. The first execution consumes the approval; the next trade needs a fresh one.',
  },
  {
    name: 'TradeOneAttemptPerApproval',
    kind: 'Dogwood · temporal forbid (anchored count + bind)',
    body: `forbid (principal,
        action == AgentCore::Action::"BankTools___execute_trade",
        resource == AgentCore::Gateway::"<gateway-arn>")
when temporal {
    bind(n,
        count for (t: Timepoint). where (
            !AgentCore::Action::"BankTools___approve_trade"::response{
                eventResource: resource,
                input.ticker: context.input.ticker,
                input.qty: context.input.qty
            }
            since within 1h
            (AgentCore::Action::"BankTools___execute_trade"::request{
                eventResource: resource,
                input.ticker: context.input.ticker,
                input.qty: context.input.qty
            } && tp(t))
        ),
        n > 1)
};`,
    note: 'Concurrency guard for the approval: it counts execution attempts (requests, which include the one being authorized and any in-flight ones) that no matching approval has followed. Two concurrent executions can no longer ride one approval — the count is anchored to the last approval, so a fresh approval resets it and a previously denied attempt does not block later trades.',
  },
  {
    name: 'TaintedSessionNoTransfer',
    kind: 'Dogwood · temporal forbid (taint)',
    body: `forbid (principal,
        action == AgentCore::Action::"BankTools___transfer_funds",
        resource == AgentCore::Gateway::"<gateway-arn>")
when temporal {
    formerly within 1h
        AgentCore::Action::"BankTools___read_market_research"::response{
            eventResource: resource
        }
};`,
    note: 'Tainted session: once untrusted external content has been read, transfers are forbidden for the rest of the session. A forbid overrides every permit — even a transfer that satisfies TransferRequiresLookup is denied. Prompt-injection containment, enforced outside the model.',
  },
  {
    name: 'dogwood-gateway-tool-storm',
    kind: 'Gateway rate limit (not a policy: enforced before policies)',
    body: `dimensionKeys: ["toolName"]
entries:
  - dimensions: { toolName: "BankTools___get_market_news" }
    requests: [ { rate: 1, period: second } ]
  - dimensions: { toolName: "*" }
    requests: [ { rate: 300, period: minute } ]`,
    note: 'A concurrent runaway loop against this tool gets a large share of its calls throttled at 1 request/second, while every other tool keeps its own generous bucket.',
  },
];

export function PoliciesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="modal"
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 30, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>What is on the wall</h2>
              <button className="modal-close" onClick={onClose}>✕</button>
            </div>
            <p className="modal-intro">
              These rules run at the AgentCore Gateway, outside the agent&apos;s code. The agent
              never sees them and cannot reason around them. The statements below mirror the
              policies deployed by this stack.
            </p>
            {POLICIES.map((policy) => (
              <div className="policy-card" key={policy.name}>
                <div className="policy-head">
                  <code>{policy.name}</code>
                  <span>{policy.kind}</span>
                </div>
                <pre>{policy.body}</pre>
                <p>{policy.note}</p>
              </div>
            ))}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
