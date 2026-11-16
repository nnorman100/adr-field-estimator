'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { fieldUser } from '@/lib/field-db';
import type { DsMe } from '@/lib/field/ds-me';
import { pending } from '@/lib/field/pending';
import { watchSignIn, type FieldSession } from '@/lib/field/session';
import { placeOf } from '@/lib/field/views';
import { JobScreens } from './job-screens';
import { JobsView } from './jobs-view';
import { NewJobView } from './new-job-view';
import { useFieldClient } from './field-store';

// Identity and cache come from FieldStore's gate, including its saved offline facts.
export function FieldApp({ me }: { me: DsMe }) {
  const params = useSearchParams();
  const place = placeOf(new URLSearchParams(params.toString()));
  const field = useFieldClient();
  const [opened, setOpened] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const user = field ? fieldUser(field.client.person) : null;
  const session = useMemo<FieldSession | null>(() => {
    if (!field || !user || !field.me.companyId || !field.me.role) return null;
    return {
      user, db: field.client.db, client: field.client,
      companyId: field.me.companyId, role: field.me.role, capabilities: field.me.capabilities,
      online: field.online, offlineCapture: field.offlineCapture,
    };
  }, [field, user]);
  const companyId = session?.companyId;
  const uid = session?.user.uid;
  useEffect(() => {
    if (!companyId || !uid) return;
    return watchSignIn(me, uid, () => setLost(true), () => {
      pending.openFor(`${companyId}/${uid}`);
      setOpened(`${companyId}/${uid}`);
    });
  }, [me, companyId, uid]);

  if (!field) return <p role="status">The field database is not set up for this company yet.</p>;
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
  if (place.view === 'jobs') return <JobsView key={place.list ?? 'default'} session={session} list={place.list} />;
  if (place.view === 'new-job') return <NewJobView session={session} />;
  return <JobScreens key={place.jobId} session={session} jobId={place.jobId} view={place.view} />;
}
