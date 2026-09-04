// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { TrajectoryEvent } from '../lib/types';

const BADGES: Record<string, string> = {
  ALLOW: 'badge-allow',
  DENY: 'badge-deny',
  THROTTLED: 'badge-throttle',
  TOOL_ERROR: 'badge-toolerr',
  ERROR: 'badge-error',
};

export function DecisionLog({ events, mode }: { events: TrajectoryEvent[]; mode: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  const verdicts = events.filter((e) => e.kind === 'verdict');
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [verdicts.length]);

  return (
    <div className="panel decisions">
      <div className="panel-title">GATEWAY DECISIONS</div>
      <div className="panel-scroll">
        {verdicts.length === 0 && (
          <div className="placeholder">Every tool call is judged at the gateway, outside the agent.</div>
        )}
        {verdicts.map((event) => (
          <motion.div
            key={event.seq}
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            className={`decision decision-${event.decision}`}
          >
            <div className="decision-head">
              <span className={`badge ${BADGES[event.decision ?? 'ERROR']}`}>
                {event.decision}
                {event.decision === 'ALLOW' && mode === 'LOG_ONLY' ? ' · LOG_ONLY' : ''}
              </span>
              <code className="decision-tool">{(event.tool ?? '').split('___').pop()}</code>
              {typeof event.latencyMs === 'number' && (
                <span className="decision-latency">{event.latencyMs}ms</span>
              )}
            </div>
            {event.detail && <div className="decision-detail">{trim(event.detail)}</div>}
          </motion.div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function trim(detail: string): string {
  return detail.length > 260 ? `${detail.slice(0, 260)}…` : detail;
}
