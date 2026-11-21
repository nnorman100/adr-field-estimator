'use client';

import type { Auth, User } from 'firebase/auth';
import { useCallback, useEffect, useState } from 'react';
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
}: {
  auth: Auth;
  signIn: SignIn;
  user: User;
  jobId: string;
  agreementId: string;
  initial: DryingAccess;
}) {
  const isCurrent = useCallback(() => stillSameSignIn(auth, signIn), [auth, signIn]);
  const [access, setAccess] = useState<DryingAccess | null>(initial);
  const [checking, setChecking] = useState(false);
  const online = useBrowserOnline();

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
        const latest = dryingAccess(answer.body);
        setAccess(
          latest?.actorId === initial.actorId && latest.companyId === initial.companyId
            ? latest
            : null,
        );
      } else if (accessRefused(answer.status)) {
        setAccess(null);
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
  }, [initial.actorId, initial.companyId, isCurrent, user]);

  if (!access || !isCurrent()) return null;
  return (
    <DryingCards
      session={{
        user,
        jobId,
        isCurrent,
        online: online && !checking,
        visible: true,
        canAdd: access.canAdd,
        office: access.office,
      }}
      watchEnabled={access.watchEnabled}
      agreementId={agreementId}
    />
  );
}
