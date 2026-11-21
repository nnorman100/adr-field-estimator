'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { DryingLog } from './drying-log';
import { DryingWatch } from './drying-watch';
import type { DryingContext } from './requests';

export function DryingCards({
  session,
  watchEnabled,
  agreementId,
  onRefused,
}: {
  session: DryingContext;
  watchEnabled: boolean;
  agreementId?: string;
  // The enclosing screen rechecks job access and drops what it shows of the job.
  onRefused: (status: number) => void;
}) {
  const [changes, setChanges] = useState(0);
  const [refused, setRefused] = useState(false);
  const parent = useRef(onRefused);
  useLayoutEffect(() => {
    parent.current = onRefused;
  });
  const rechecked = useRef(false);
  const refuse = useCallback((status: number, ambiguous = false) => {
    if (ambiguous) {
      if (rechecked.current) return;
      rechecked.current = true;
    } else setRefused(true);
    parent.current(status);
  }, []);
  const { changed } = session;
  const accepted = useCallback(() => {
    setChanges((count) => count + 1);
    changed?.();
  }, [changed]);
  const requestSession = { ...session, refused: refused || session.blocked === true, onRefused: refuse };
  return (
    <div hidden={!session.visible} className="min-w-0 flex-col gap-4 [&:not([hidden])]:flex">
      <DryingLog session={requestSession} onChanges={accepted} />
      {watchEnabled ? (
        <DryingWatch
          session={requestSession}
          agreementId={agreementId}
          changes={`${changes}:${session.refreshOn ?? ''}`}
        />
      ) : null}
    </div>
  );
}
