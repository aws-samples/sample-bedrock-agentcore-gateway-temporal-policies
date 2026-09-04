// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Act } from '../lib/types';

const ACT_ICONS: Record<string, string> = {
  act1: '01',
  act2: '02',
  act3: '03',
  act4: '04',
  act5: '05',
  act6: '06',
};

/**
 * Horizontal slider of scenario cards: hidden scrollbar, scroll-snap,
 * drag-to-scroll for mouse users, and vertical wheel converted to
 * horizontal scrolling. A drag suppresses the click so cards are not
 * accidentally triggered while sliding. For plain-click mouse users a
 * nav row below the cards offers left/right paging arrows; they only
 * appear when the cards actually overflow, and dim at the edges.
 */
export function ActBar({
  acts,
  running,
  activeAct,
  onSelect,
  onInfo,
}: {
  acts: Act[];
  running: boolean;
  activeAct: string | null;
  /** Arms the scenario (shows its operator message); does not run it. */
  onSelect: (actId: string) => void;
  onInfo: (actId: string) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, moved: false, startX: 0, startScroll: 0 });
  const [nav, setNav] = useState({ overflow: false, atStart: true, atEnd: true });

  const updateNav = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const max = bar.scrollWidth - bar.clientWidth;
    setNav({
      overflow: max > 4,
      atStart: bar.scrollLeft <= 4,
      atEnd: bar.scrollLeft >= max - 4,
    });
  }, []);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        bar.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    bar.addEventListener('wheel', onWheel, { passive: false });
    bar.addEventListener('scroll', updateNav, { passive: true });
    const resize = new ResizeObserver(updateNav);
    resize.observe(bar);
    updateNav();
    return () => {
      bar.removeEventListener('wheel', onWheel);
      bar.removeEventListener('scroll', updateNav);
      resize.disconnect();
    };
  }, [updateNav, acts.length]);

  const page = (direction: -1 | 1) => {
    const bar = barRef.current;
    if (!bar) return;
    // Scroll by most of the visible width so consecutive cards stay in view.
    bar.scrollBy({ left: direction * bar.clientWidth * 0.8, behavior: 'smooth' });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return;
    drag.current = { active: true, moved: false, startX: e.clientX, startScroll: bar.scrollLeft };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar || !drag.current.active) return;
    const dx = e.clientX - drag.current.startX;
    if (Math.abs(dx) > 6) drag.current.moved = true;
    if (drag.current.moved) bar.scrollLeft = drag.current.startScroll - dx;
  };
  const endDrag = () => {
    drag.current.active = false;
  };
  const suppressClickIfDragged = (e: React.MouseEvent) => {
    if (drag.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      drag.current.moved = false;
    }
  };

  return (
    <div className="act-bar-shell">
      <div
        className="act-bar"
        ref={barRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onClickCapture={suppressClickIfDragged}
      >
        {acts.map((act, index) => (
          <div className="act-wrap" key={act.id} {...(index === 0 ? { 'data-tour': 'act-card' } : {})}>
            <button
              className={`act-button ${activeAct === act.id ? 'act-active' : ''}`}
              disabled={running}
              onClick={() => onSelect(act.id)}
              title={act.expectation}
            >
              <span className="act-number">{ACT_ICONS[act.id] ?? '·'}</span>
              <span className="act-copy">
                <strong>{act.title}</strong>
                <small>{act.subtitle}</small>
              </span>
            </button>
            <button
              className="info-dot"
              {...(index === 0 ? { 'data-tour': 'info-dot' } : {})}
              aria-label={`About ${act.title}`}
              title="Scenario, risk, and what makes this enforceable"
              onClick={(e) => {
                e.stopPropagation();
                onInfo(act.id);
              }}
            >
              i
            </button>
          </div>
        ))}
      </div>
      {nav.overflow && (
        <div className="act-nav">
          <button
            className="act-nav-arrow"
            aria-label="Scroll scenarios left"
            title="More scenarios to the left"
            disabled={nav.atStart}
            onClick={() => page(-1)}
          >
            ‹
          </button>
          <button
            className="act-nav-arrow"
            aria-label="Scroll scenarios right"
            title="More scenarios to the right"
            disabled={nav.atEnd}
            onClick={() => page(1)}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
