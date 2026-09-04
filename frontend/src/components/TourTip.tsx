// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useEffect, useState } from 'react';

const TIP_WIDTH = 264;
const EDGE_MARGIN = 12;

/**
 * First-run tour callout. Anchors below the element matching `selector`,
 * follows it through act-bar scrolling and window resizes (position: fixed,
 * so it is never clipped by the slider's overflow), and renders nothing
 * while the anchor is absent. Purely presentational: it never intercepts
 * events on the anchored element itself.
 */
export function TourTip({
  selector,
  step,
  title,
  text,
  onSkip,
}: {
  /** CSS selector of the element to point at (a data-tour attribute). */
  selector: string;
  /** Progress label, e.g. "1 / 3". */
  step: string;
  title: string;
  text: string;
  /** Dismisses the whole tour. */
  onSkip: () => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(selector);
      if (!el) {
        setAnchor(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setAnchor((prev) => {
        const next = { x: r.left + r.width / 2, y: r.bottom };
        return prev && prev.x === next.x && prev.y === next.y ? prev : next;
      });
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    // capture-phase scroll catches the act bar's own horizontal scrolling
    document.addEventListener('scroll', schedule, true);
    const interval = setInterval(measure, 400); // safety net for layout shifts
    return () => {
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      clearInterval(interval);
      cancelAnimationFrame(raf);
    };
  }, [selector]);

  if (!anchor) return null;

  const half = TIP_WIDTH / 2;
  const left = Math.min(Math.max(anchor.x, half + EDGE_MARGIN), window.innerWidth - half - EDGE_MARGIN);
  // Keep the arrow pointing at the anchor even when the box is edge-clamped.
  const arrowOffset = Math.min(Math.max(anchor.x - left, -half + 22), half - 22);

  return (
    <div
      className="tour-tip"
      role="status"
      style={{ top: anchor.y + 12, left, width: TIP_WIDTH, ['--arrow-shift' as string]: `${arrowOffset}px` }}
    >
      <div className="tour-tip-head">
        <span className="tour-tip-step">TOUR {step}</span>
        <button className="tour-tip-skip" aria-label="Skip the tour" title="Skip the tour" onClick={onSkip}>
          ✕
        </button>
      </div>
      <strong className="tour-tip-title">{title}</strong>
      <p className="tour-tip-text">{text}</p>
    </div>
  );
}
