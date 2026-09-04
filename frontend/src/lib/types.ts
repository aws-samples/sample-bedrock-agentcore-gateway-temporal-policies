// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
export type Decision = 'ALLOW' | 'DENY' | 'THROTTLED' | 'TOOL_ERROR' | 'ERROR';

export interface TrajectoryEvent {
  runId: string;
  seq: number;
  ts: number;
  kind:
    | 'run_started'
    | 'user_prompt'
    | 'model_text'
    | 'model_usage'
    | 'tool_call'
    | 'verdict'
    | 'burst_started'
    | 'run_finished'
    | 'run_error';
  actId: string;
  tool?: string;
  args?: string;
  text?: string;
  decision?: Decision;
  detail?: string;
  latencyMs?: number;
  httpStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
  simulated?: boolean;
  sessionId?: string;
}

export interface Act {
  id: string;
  title: string;
  subtitle: string;
  mode: 'agent' | 'burst';
  prompt?: string;
  expectation: string;
  /** Short tool names the scenario uses; the canvas shows only these. */
  tools?: string[];
}

export interface DemoConfig {
  acts: Act[];
  mode: 'ENFORCE' | 'LOG_ONLY';
  sessionBudget: number;
}

export interface RuntimeConfig {
  apiUrl: string;
  cognitoDomain: string;
  clientId: string;
  redirectUri: string;
}
