'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { fieldUser } from '@/lib/field-db';
import { meKey, type DsMe } from '@/lib/field/ds-me';
import { pending } from '@/lib/field/pending';
import { sessionIdentity, watchSignIn, type FieldSession } from '@/lib/field/session';
import { placeOf } from '@/lib/field/views';
import { JobScreens } from './job-screens';
import { JobsView } from './jobs-view';
import { NewJobView } from './new-job-view';
import { SyncChip } from './sync-chip';
import { useFieldClient } from './field-store';
import { restoreKept } from '@/lib/field/update-keep';

// Identity and cache come from FieldStore's gate, including its saved offline facts.
export function FieldApp({ me }: { me: DsMe }) {
  const params = useSearchParams();
  const place = placeOf(new URLSearchParams(params.toString()));
  const field = useFieldClient();
  const [opened, setOpened] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const user = field ? fieldUser(field.client.person) : null;
  const session = useMemo<FieldSession | null>(() => {
    const identity = field ? sessionIdentity(field.me) : null;
    if (!field || !user || identity === null || identity === 'needs-check') return null;
    return {
      user, db: field.client.db, client: field.client,
      companyId: identity.companyId, actorId: identity.actorId, role: identity.role, capabilities: field.me.capabilities,
      readiness: field.gate.kind === 'open' && field.gate.facts.readiness === true,
      online: field.online, offlineCapture: field.offlineCapture,
    };
  }, [field, user]);
  const companyId = session?.companyId;
  const uid = session?.user.uid;
  useEffect(() => {
    if (!companyId || !uid) return;
    return watchSignIn(me, uid, () => setLost(true), () => {
      const owner = meKey(me.tenantId, uid);
      pending.openFor(owner);
      void restoreKept(owner);
      setOpened(`${companyId}/${uid}`);
    });
  }, [me, companyId, uid]);

  if (!field) return <p role="status">The field database is not set up for this company yet.</p>;
  // A sign-in saved before the person's actor id was kept needs one online check to learn it.
  if (!session && !lost && sessionIdentity(field.me) === 'needs-check') {
    return <p role="status">Open this app once with a signal to finish setting it up.</p>;
  }
  if (!session || lost) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-base">Sign in again to see your jobs.</p>
        <a className="inline-flex min-h-11 items-center text-base font-medium underline" href={`/sign-in/${me.address}`}>
          Go to sign in
        </a>
      </div>
    );
  }
  if (opened !== `${session.companyId}/${session.user.uid}`) return <p role="status">Opening your jobs…</p>;
  // The sync chip and its sheet show the signed-in person's journal only while their screens do.
  return (
    <>
      <SyncChip me={me} />
      {place.view === 'jobs' ? (
        <JobsView key={place.list ?? 'default'} session={session} list={place.list} />
      ) : place.view === 'new-job' ? (
        <NewJobView session={session} />
      ) : (
        <JobScreens key={place.jobId} session={session} jobId={place.jobId} view={place.view} readinessFix={params.get('fix')} address={me.address} />
      )}
    </>
  );
}
