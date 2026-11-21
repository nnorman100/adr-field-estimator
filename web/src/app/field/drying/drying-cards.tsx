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
  // The enclosing screen reads the job again to confirm a refusal and drops what it shows of the job.
  // `ambiguous` marks a watch 404 that may only mean the feature is off.
  onRefused: (status: number, ambiguous: boolean) => void | Promise<void>;
}) {
  const [changes, setChanges] = useState(0);
  const [refused, setRefused] = useState(false);
  const [watchSeen, setWatchSeen] = useState(watchEnabled);
  if (watchEnabled && !watchSeen) setWatchSeen(true);
  const parent = useRef(onRefused);
  useLayoutEffect(() => {
    parent.current = onRefused;
  });
  const checking = useRef(false);
  const refuse = useCallback((status: number, ambiguous = false) => {
    if (!ambiguous) setRefused(true);
    if (checking.current) return;
    checking.current = true;
    void Promise.resolve(parent.current(status, ambiguous)).finally(() => {
      checking.current = false;
    });
  }, []);
  const { changed } = session;
  const accepted = useCallback(() => {
    setChanges((count) => count + 1);
    changed?.();
  }, [changed]);
  const requestSession = {
    ...session,
    refused: refused || session.blocked === true,
    onRefused: refuse,
  };
  return (
    <div hidden={!session.visible} className="min-w-0 flex-col gap-4 [&:not([hidden])]:flex">
      <DryingLog session={requestSession} onChanges={accepted} />
      {watchSeen ? (
        <DryingWatch
          session={requestSession}
          enabled={watchEnabled}
          agreementId={agreementId}
          changes={`${changes}:${session.refreshOn ?? ''}`}
        />
      ) : null}
    </div>
  );
}
