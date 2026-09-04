// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import type { DemoConfig, RuntimeConfig, TrajectoryEvent } from './types';
import { currentAccessToken, redirectToLogin } from './auth';

let runtime: RuntimeConfig | null = null;

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (runtime) return runtime;
  const response = await fetch('/config.json', { cache: 'no-store' });
  runtime = (await response.json()) as RuntimeConfig;
  return runtime;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = await loadRuntimeConfig();
  const token = currentAccessToken();
  const response = await fetch(`${cfg.apiUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 401) {
    // Token expired mid-session: send the user back through the Hosted UI.
    sessionStorage.removeItem('dg-auth-tokens');
    await redirectToLogin(cfg);
    throw new Error('401: redirecting to sign-in');
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${body.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

export const api = {
  config: () => call<DemoConfig>('/config'),
  run: (actId: string) => call<{ runId: string }>('/run', { method: 'POST', body: JSON.stringify({ actId }) }),
  events: (runId: string, since: number) =>
    call<{ events: TrajectoryEvent[]; done: boolean }>(`/events?runId=${runId}&since=${since}`),
  setMode: (mode: 'ENFORCE' | 'LOG_ONLY') =>
    call<{ mode: string }>('/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
};
