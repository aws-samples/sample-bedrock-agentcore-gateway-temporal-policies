// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { TrajectoryEvent } from '../lib/types';

export function Transcript({ events }: { events: TrajectoryEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [events.length]);

  const visible = events.filter((e) =>
    ['user_prompt', 'model_text', 'tool_call', 'burst_started', 'run_error'].includes(e.kind),
  );

  return (
    <div className="panel transcript">
      <div className="panel-title">AGENT TRANSCRIPT</div>
      <div className="panel-scroll">
        {visible.length === 0 && (
          <div className="placeholder">
            Pick a scenario above, read the operator message, then press send to trigger the agent.
          </div>
        )}
        {visible.map((event) => (
          <motion.div
            key={event.seq}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className={`bubble bubble-${event.kind}`}
          >
            {event.kind === 'user_prompt' && (
              <>
                <span className="bubble-tag">OPERATOR</span>
                {event.text}
              </>
            )}
            {event.kind === 'model_text' && (
              <>
                <span className="bubble-tag tag-agent">AGENT</span>
                {event.text}
              </>
            )}
            {event.kind === 'tool_call' && (
              <>
                <span className="bubble-tag tag-tool">
                  TOOL CALL{event.simulated ? ' · SIMULATED' : ''}
                </span>
                <code>
                  {(event.tool ?? '').split('___').pop()}({formatArgs(event.args)})
                </code>
              </>
            )}
            {event.kind === 'burst_started' && (
              <>
                <span className="bubble-tag tag-warn">SIMULATION</span>
                {event.text}
              </>
            )}
            {event.kind === 'run_error' && (
              <>
                <span className="bubble-tag tag-deny">RUN ERROR</span>
                {event.detail}
              </>
            )}
          </motion.div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function formatArgs(args?: string): string {
  if (!args) return '';
  try {
    const parsed = JSON.parse(args);
    return Object.entries(parsed)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
  } catch {
    return args.slice(0, 80);
  }
}
