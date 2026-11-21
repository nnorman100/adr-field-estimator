'use client';

import type { Auth, User } from 'firebase/auth';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dryingWatchEnabled } from '@/lib/drying/client';
import { stillSameSignIn, type SignIn } from '@/lib/field/sign-out';
import { meActor, meFacts } from '@/lib/field/sync-gate';
import { meOutcome } from '@/lib/sign-in/outcome';
import { DryingCards } from './drying-cards';
import { accessRefused, dryingRequest, useBrowserOnline } from './requests';

export function dryingAccess(body: unknown) {
  const facts = meFacts(body);
  const { actorId } = meActor(body);
  const outcome = meOutcome(200, body);
  if (
    !facts ||
    !actorId ||
    outcome.kind !== 'signed-in' ||
    !facts.capabilities.includes('jobs_read')
  )
    return null;
  const office = outcome.role === 'office';
  return {
    companyId: facts.companyId,
    actorId,
    office,
    canAdd: !office && facts.capabilities.includes('scope'),
    watchEnabled: dryingWatchEnabled(body),
  };
}

export type DryingAccess = NonNullable<ReturnType<typeof dryingAccess>>;

export function ReviewDrying({
  auth,
  signIn,
  user,
  jobId,
  agreementId,
  initial,
  blocked,
  onRefused,
  onIdentity,
}: {
  auth: Auth;
  signIn: SignIn;
  user: User;
  jobId: string;
  agreementId: string;
  initial: DryingAccess;
  // The signed job is refused or its access was lost: fetched data is hidden, the unsent form stays.
  blocked: boolean;
  // A card was refused: a definite denial is applied at once, an ambiguous one is checked.
  onRefused: (status: number, ambiguous: boolean) => void;
  // The signed-in person changed or was refused: the review starts over.
  onIdentity: () => void;
}) {
  const isCurrent = useCallback(() => stillSameSignIn(auth, signIn), [auth, signIn]);
  const [access, setAccess] = useState<DryingAccess | null>(initial);
  const [checking, setChecking] = useState(false);
  const online = useBrowserOnline();
  const latest = useRef({ onRefused, onIdentity });
  useLayoutEffect(() => {
    latest.current = { onRefused, onIdentity };
  });
  const refused = useCallback(
    (status: number, ambiguous: boolean) => latest.current.onRefused(status, ambiguous),
    [],
  );
  const identity = useCallback(() => latest.current.onIdentity(), []);

  // Review has no field sync gate. Recheck its live feature flag and identity on foreground resume.
  useEffect(() => {
    let request: AbortController | undefined;
    function suspend() {
      request?.abort();
    }
    async function recheck() {
      suspend();
      if (document.visibilityState !== 'visible' || !navigator.onLine || !isCurrent()) return;
      const current = new AbortController();
      request = current;
      setChecking(true);
      const answer = await dryingRequest(user, '/api/me', current.signal);
      if (current.signal.aborted || !isCurrent()) return;
      if (answer.status === 200) {
        if (meFacts(answer.body) && meActor(answer.body).actorId) {
          const latest = dryingAccess(answer.body);
          if (latest?.actorId === initial.actorId && latest.companyId === initial.companyId)
            setAccess(latest);
          else identity();
        }
      } else if (accessRefused(answer.status)) {
        identity();
      }
      setChecking(false);
    }
    function shown() {
      if (document.visibilityState === 'visible') void recheck();
      else suspend();
    }
    function restored(event: PageTransitionEvent) {
      if (event.persisted) void recheck();
    }
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('pageshow', restored);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('online', recheck);
    return () => {
      suspend();
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('pageshow', restored);
      window.removeEventListener('pagehide', suspend);
      window.removeEventListener('online', recheck);
    };
  }, [initial.actorId, initial.companyId, isCurrent, user, identity]);

  if (!access || !isCurrent()) return null;
  return (
    <DryingCards
      session={{
        user,
        jobId,
        refreshOn: agreementId,
        isCurrent,
        online: online && !checking,
        visible: true,
        canAdd: access.canAdd,
        office: access.office,
        blocked,
      }}
      watchEnabled={access.watchEnabled}
      agreementId={agreementId}
      onRefused={refused}
    />
  );
}
