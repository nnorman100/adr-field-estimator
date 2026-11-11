'use client';

import { useEffect, useRef } from 'react';
import { PANEL_BODY, PANEL_HEADING, PANEL_MAIN } from './panel';

// The sign-in frame for a screen whose state changes: when the heading changes, it takes focus, so
// a screen reader announces the new state and keyboard focus is not left on a removed button.
export function FocusedPanel({ title, children }: { title: string; children: React.ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    // Not on first load: the browser's own focus order applies then.
    if (shown.current !== null && shown.current !== title) heading.current?.focus();
    shown.current = title;
  }, [title]);
  return (
    <main className={PANEL_MAIN}>
      <p className="text-sm font-semibold tracking-wide">DryScope</p>
      <h1 ref={heading} tabIndex={-1} className={PANEL_HEADING}>
        {title}
      </h1>
      <div className={PANEL_BODY}>{children}</div>
    </main>
  );
}
