'use client';

import { useCallback, useState } from 'react';
import { DryingLog } from './drying-log';
import { DryingWatch } from './drying-watch';
import type { DryingContext } from './requests';

export function DryingCards({
  session,
  watchEnabled,
  agreementId,
}: {
  session: DryingContext;
  watchEnabled: boolean;
  agreementId?: string;
}) {
  const [changes, setChanges] = useState(0);
  const [refused, setRefused] = useState(false);
  const onRefused = useCallback(() => setRefused(true), []);
  const requestSession = { ...session, refused, onRefused };
  return (
    <div hidden={!session.visible} className="min-w-0 flex-col gap-4 [&:not([hidden])]:flex">
      <DryingLog session={requestSession} onChanges={() => setChanges((count) => count + 1)} />
      {watchEnabled ? (
        <DryingWatch session={requestSession} agreementId={agreementId} changes={changes} />
      ) : null}
    </div>
  );
}
