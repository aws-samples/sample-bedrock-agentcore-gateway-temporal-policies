// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useState } from 'react';
import { api } from '../lib/api';

/**
 * Act 5: flip the gateway policy engine between ENFORCE and LOG_ONLY, then
 * re-run act 2 to show the same hallucinated transfer passing with a trace
 * instead of being blocked. Applying the change takes a few seconds because
 * the gateway must finish updating before the next act runs.
 */
export function ModeToggle({
  mode,
  disabled,
  onChanged,
}: {
  mode: 'ENFORCE' | 'LOG_ONLY';
  disabled: boolean;
  onChanged: (mode: 'ENFORCE' | 'LOG_ONLY') => void;
}) {
  const [busy, setBusy] = useState(false);

  const flip = async () => {
    const next = mode === 'ENFORCE' ? 'LOG_ONLY' : 'ENFORCE';
    setBusy(true);
    try {
      const result = await api.setMode(next);
      onChanged(result.mode as 'ENFORCE' | 'LOG_ONLY');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={`mode-toggle mode-${mode.toLowerCase()}`}
      onClick={flip}
      disabled={disabled || busy}
      title="Act 5: flip enforcement, then re-run Act 2"
    >
      <span className="mode-dot" />
      {busy ? 'UPDATING GATEWAY…' : mode === 'ENFORCE' ? 'ENFORCE' : 'LOG_ONLY'}
    </button>
  );
}
