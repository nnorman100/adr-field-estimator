'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DsMe } from '@/lib/field/ds-me';
import { pending } from '@/lib/field/pending';
import { openSession, watchSignIn, type SessionOutcome } from '@/lib/field/session';
import { placeOf } from '@/lib/field/views';
import { JobScreens } from './job-screens';
import { JobsView } from './jobs-view';
import { NewJobView } from './new-job-view';

// The job screens inside the field shell (S5a-6). The shell starts from the saved sign-in; this
// asks the server who the person is (role, capabilities, company) and then shows the view the
// address names (src/lib/field/views.ts). Nothing here is rendered on the server.
export function FieldApp({ me }: { me: DsMe }) {
  const params = useSearchParams();
  const place = placeOf(new URLSearchParams(params.toString()));
  const [outcome, setOutcome] = useState<SessionOutcome | null>(null);

  const start = useCallback(() => {
    let live = true;
    openSession(me).then(
      (next) => {
        if (!live) return;
        if (next.kind === 'ready') pending.openFor(`${next.session.companyId}/${next.session.user.uid}`);
        setOutcome(next);
      },
      () => {
        if (live) setOutcome({ kind: 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [me]);

  useEffect(() => start(), [start]);

  // Nothing of this person's stays on screen once the phone's sign-in is someone else's or no one's.
  const signedIn = outcome?.kind === 'ready' ? outcome.session.user.uid : null;
  useEffect(() => {
    if (signedIn === null) return;
    return watchSignIn(me, signedIn, () => setOutcome({ kind: 'sign-in-again' }));
  }, [me, signedIn]);

  if (outcome === null) return <p role="status">Opening your jobs…</p>;
  if (outcome.kind === 'sign-in-again') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-base">Sign in again to see your jobs.</p>
        <a className="inline-flex min-h-11 items-center text-base font-medium underline" href={`/sign-in/${me.address}`}>
          Go to sign in
        </a>
      </div>
    );
  }
  if (outcome.kind === 'unavailable') {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-base">
          Your jobs could not be opened just now.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setOutcome(null);
            start();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const { session } = outcome;
  if (place.view === 'jobs') return <JobsView key={place.list ?? 'default'} session={session} list={place.list} />;
  if (place.view === 'new-job') return <NewJobView session={session} />;
  return <JobScreens key={place.jobId} session={session} jobId={place.jobId} view={place.view} />;
}
