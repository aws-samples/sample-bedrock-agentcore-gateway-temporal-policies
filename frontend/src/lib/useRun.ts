// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { TrajectoryEvent } from './types';

/**
 * Starts acts, polls the events API, and releases events one by one on a
 * short stagger so the canvas, transcript, and decision log animate in sync
 * even when a poll returns a whole batch at once.
 */
export function useRun() {
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [played, setPlayed] = useState<TrajectoryEvent[]>([]);

  const queue = useRef<TrajectoryEvent[]>([]);
  const lastSeq = useRef(0);
  const backendDone = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (stageTimer.current) clearInterval(stageTimer.current);
    pollTimer.current = null;
    stageTimer.current = null;
  }, []);

  /** Clears the previous run (transcript, decisions, canvas) without starting a new one. */
  const reset = useCallback(() => {
    stop();
    queue.current = [];
    lastSeq.current = 0;
    backendDone.current = false;
    setPlayed([]);
    setRunning(false);
    setRunId(null);
  }, [stop]);

  const start = useCallback(
    async (actId: string) => {
      stop();
      queue.current = [];
      lastSeq.current = 0;
      backendDone.current = false;
      setPlayed([]);
      setRunning(true);

      const { runId: newRunId } = await api.run(actId);
      setRunId(newRunId);

      pollTimer.current = setInterval(async () => {
        if (backendDone.current) return;
        try {
          const { events, done } = await api.events(newRunId, lastSeq.current);
          if (events.length > 0) {
            lastSeq.current = Math.max(...events.map((e) => e.seq));
            queue.current.push(...events.sort((a, b) => a.seq - b.seq));
          }
          if (done) backendDone.current = true;
        } catch {
          // transient poll failure: keep trying until the run finishes
        }
      }, 700);

      stageTimer.current = setInterval(() => {
        if (queue.current.length === 0) {
          if (backendDone.current) {
            stop();
            setRunning(false);
          }
          return;
        }
        // Normally release one event per tick so the scene stays legible;
        // during long bursts (act 4) drain faster so the storm feels like one.
        const batchSize = Math.min(6, Math.max(1, Math.ceil(queue.current.length / 10)));
        const batch = queue.current.splice(0, batchSize);
        setPlayed((prev) => [...prev, ...batch]);
        if (batch.some((e) => e.kind === 'run_finished' || e.kind === 'run_error')) {
          stop();
          setRunning(false);
        }
      }, 320);
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { runId, running, events: played, start, reset };
}
