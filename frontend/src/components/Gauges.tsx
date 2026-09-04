// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { motion } from 'framer-motion';
import type { TrajectoryEvent } from '../lib/types';

/** Bottom bar: session budget arc, token counters, throughput bar. */
export function Gauges({ events, budget }: { events: TrajectoryEvent[]; budget: number }) {
  const spent = events
    .filter((e) => e.kind === 'verdict' && e.decision === 'ALLOW' && (e.tool ?? '').endsWith('purchase_item'))
    .reduce((total, e) => total + argAmount(e.args), 0);
  const deniedSpend = events
    .filter((e) => e.kind === 'verdict' && e.decision === 'DENY' && (e.tool ?? '').endsWith('purchase_item'))
    .reduce((total, e) => total + argAmount(e.args), 0);

  const inputTokens = sum(events, 'inputTokens');
  const outputTokens = sum(events, 'outputTokens');

  const verdicts = events.filter((e) => e.kind === 'verdict');
  const throttled = verdicts.filter((e) => e.decision === 'THROTTLED').length;
  const allowed = verdicts.filter((e) => e.decision === 'ALLOW').length;
  const denied = verdicts.filter((e) => e.decision === 'DENY').length;

  return (
    <div className="gauges">
      <BudgetArc spent={spent} attempted={deniedSpend} budget={budget} />
      <div className="gauge-block">
        <div className="gauge-label">TOKENS CONSUMED</div>
        <div className="token-row">
          <Counter value={inputTokens} label="in" />
          <Counter value={outputTokens} label="out" />
        </div>
      </div>
      <div className="gauge-block">
        <div className="gauge-label">GATEWAY VERDICTS</div>
        <div className="verdict-row">
          <span className="pill pill-allow">{allowed} allow</span>
          <span className="pill pill-deny">{denied} deny</span>
          <span className="pill pill-throttle">{throttled} throttled</span>
        </div>
      </div>
    </div>
  );
}

function BudgetArc({ spent, attempted, budget }: { spent: number; attempted: number; budget: number }) {
  const radius = 44;
  const circumference = Math.PI * radius; // semicircle
  const fraction = Math.min(spent / budget, 1);
  const overFraction = Math.min((spent + attempted) / budget, 1.12);
  return (
    <div className="gauge-block budget">
      <div className="gauge-label">SESSION BUDGET · ${budget.toLocaleString()}</div>
      <svg viewBox="0 0 120 70" className="budget-svg">
        <path d="M 10 62 A 50 50 0 0 1 110 62" fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="9" strokeLinecap="round" />
        {attempted > 0 && (
          <motion.path
            d="M 10 62 A 50 50 0 0 1 110 62"
            fill="none"
            stroke="rgba(255,59,92,0.45)"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={circumference * 1.135}
            animate={{ strokeDashoffset: circumference * 1.135 * (1 - overFraction) }}
            transition={{ type: 'spring', stiffness: 60 }}
          />
        )}
        <motion.path
          d="M 10 62 A 50 50 0 0 1 110 62"
          fill="none"
          stroke={fraction > 0.85 ? '#ffb020' : '#22e584'}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference * 1.135}
          initial={{ strokeDashoffset: circumference * 1.135 }}
          animate={{ strokeDashoffset: circumference * 1.135 * (1 - fraction) }}
          transition={{ type: 'spring', stiffness: 60 }}
        />
        <text x="60" y="52" textAnchor="middle" className="budget-value">
          ${spent.toLocaleString()}
        </text>
        <text x="60" y="66" textAnchor="middle" className="budget-sub">
          {attempted > 0 ? `+$${attempted.toLocaleString()} blocked` : 'spent'}
        </text>
      </svg>
    </div>
  );
}

function Counter({ value, label }: { value: number; label: string }) {
  return (
    <div className="counter">
      <motion.span key={value} initial={{ opacity: 0.4, scale: 1.15 }} animate={{ opacity: 1, scale: 1 }}>
        {value.toLocaleString()}
      </motion.span>
      <em>{label}</em>
    </div>
  );
}

function sum(events: TrajectoryEvent[], key: 'inputTokens' | 'outputTokens'): number {
  return events.reduce((total, e) => total + (typeof e[key] === 'number' ? (e[key] as number) : 0), 0);
}

function argAmount(args?: string): number {
  if (!args) return 0;
  try {
    const parsed = JSON.parse(args);
    return typeof parsed.amount === 'number' ? parsed.amount : 0;
  } catch {
    return 0;
  }
}
