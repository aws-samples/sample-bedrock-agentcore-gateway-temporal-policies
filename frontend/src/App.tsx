// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useEffect, useState } from 'react';
import { api, loadRuntimeConfig } from './lib/api';
import { ensureAuthenticated, signOut } from './lib/auth';
import { useRun } from './lib/useRun';
import type { Act, DemoConfig, RuntimeConfig } from './lib/types';
import { PhysicsCanvas } from './components/PhysicsCanvas';
import { Transcript } from './components/Transcript';
import { DecisionLog } from './components/DecisionLog';
import { Gauges } from './components/Gauges';
import { ActBar } from './components/ActBar';
import { ModeToggle } from './components/ModeToggle';
import { PoliciesModal } from './components/PoliciesModal';
import { ActInfoModal } from './components/ActInfoModal';
import { TourTip } from './components/TourTip';

/** First-run tour: each step disappears once its action is performed. */
type TourStep = 'info' | 'select' | 'send' | 'done';

export default function App() {
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAct, setSelectedAct] = useState<Act | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [infoAct, setInfoAct] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [tourStep, setTourStep] = useState<TourStep>('info');
  const { running, events, start, reset } = useRun();

  useEffect(() => {
    (async () => {
      try {
        const cfg = await loadRuntimeConfig();
        setRuntime(cfg);
        const tokens = await ensureAuthenticated(cfg);
        if (!tokens) return; // redirecting to the Hosted UI
        setConfig(await api.config());
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  // Selecting a card only arms the scenario; the user reads the operator
  // message in the compose bar and presses send to trigger the agent.
  const sendAct = async () => {
    if (!selectedAct || running) return;
    setTourStep((s) => (s === 'send' ? 'done' : s)); // tour: send performed
    try {
      await start(selectedAct.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const composeText = (act: Act): string =>
    act.prompt ??
    `${act.subtitle}. Press send to launch the simulated burst (labeled as simulated in the transcript).`;

  if (error) {
    return (
      <div className="boot-error">
        <h1>AgentCore Gateway + Dogwood</h1>
        <p>Could not reach the demo API. Check config.json and the deployment.</p>
        <pre>{error}</pre>
      </div>
    );
  }
  if (!config) {
    return <div className="boot">Signing in…</div>;
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <h1>
            AGENTCORE GATEWAY <span className="accent">+ DOGWOOD</span>
          </h1>
          <p>Temporal policies and rate limits, enforced at the gateway · Amazon Bedrock AgentCore</p>
        </div>
        <div className="header-actions">
          <button className="policies-button" onClick={() => setPoliciesOpen(true)}>
            ⌬ What&apos;s on the wall
          </button>
          <ModeToggle
            mode={config.mode}
            disabled={running}
            onChanged={(mode) => setConfig({ ...config, mode })}
          />
          {runtime && (
            <button className="signout-button" onClick={() => signOut(runtime)} title="Sign out">
              ⏻
            </button>
          )}
        </div>
      </header>

      {config.mode === 'LOG_ONLY' && (
        <div className="logonly-banner">
          LOG_ONLY: the policy engine still evaluates every call and records its decision, but does
          not enforce it. Re-run Act 2 and watch the hallucinated transfer pass through.
        </div>
      )}

      <ActBar
        acts={config.acts}
        running={running}
        activeAct={selectedAct?.id ?? null}
        onSelect={(actId) => {
          // Picking a scenario clears the previous run's transcript and
          // decisions so the story on screen always matches the selection.
          reset();
          setSelectedAct(config.acts.find((a) => a.id === actId) ?? null);
          // tour: card pressed (also covers users who skipped the info step)
          setTourStep((s) => (s === 'info' || s === 'select' ? 'send' : s));
        }}
        onInfo={setInfoAct}
      />

      {selectedAct && (
        <div className="compose">
          <span className="compose-tag">OPERATOR</span>
          <p className="compose-text">{composeText(selectedAct)}</p>
          <button
            className="send-button"
            data-tour="send"
            onClick={sendAct}
            disabled={running}
            title="Send this message to the agent"
            aria-label="Send to the agent"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M2 21l21-9L2 3v7l15 2-15 2v7z" />
            </svg>
          </button>
        </div>
      )}

      <main className="stage">
        <Transcript events={events} />
        <div className="panel canvas-panel">
          <PhysicsCanvas events={events} mode={config.mode} tools={selectedAct?.tools} />
        </div>
        <DecisionLog events={events} mode={config.mode} />
      </main>

      <Gauges events={events} budget={config.sessionBudget} />

      <footer className="footer">
        All accounts, customers, and funds are synthetic demo data. Policies are enforced by Policy
        in AgentCore at the gateway, outside the agent&apos;s code. Act 4 sends scripted concurrent
        burst traffic (labeled) so the rate limit trips visibly.
      </footer>

      <PoliciesModal open={policiesOpen} onClose={() => setPoliciesOpen(false)} />
      <ActInfoModal
        actId={infoAct}
        onClose={() => {
          setInfoAct(null);
          // tour: brief read and closed -> point at the scenario card
          setTourStep((s) => (s === 'info' ? 'select' : s));
        }}
      />

      {/* First-run tour: one callout at a time, hidden while a modal is open. */}
      {tourStep !== 'done' && !infoAct && !policiesOpen && (
        <>
          {tourStep === 'info' && (
            <TourTip
              selector='[data-tour="info-dot"]'
              step="1 / 3"
              title="Start here"
              text="Open the scenario brief: what happens, the risk, and what the gateway enforces."
              onSkip={() => setTourStep('done')}
            />
          )}
          {tourStep === 'select' && (
            <TourTip
              selector='[data-tour="act-card"]'
              step="2 / 3"
              title="Press the scenario card"
              text="Selecting it arms the scenario and shows the operator's message below."
              onSkip={() => setTourStep('done')}
            />
          )}
          {tourStep === 'send' && selectedAct && (
            <TourTip
              selector='[data-tour="send"]'
              step="3 / 3"
              title="Send it to the agent"
              text="This is the operator's message the agent will receive. Press send and watch every tool call hit the wall."
              onSkip={() => setTourStep('done')}
            />
          )}
        </>
      )}
    </div>
  );
}
