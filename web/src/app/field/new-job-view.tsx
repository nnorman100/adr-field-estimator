'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { createJob, type NewJob } from '@/lib/field/api';
import type { FieldSession } from '@/lib/field/session';
import { Box, FieldLink, go, Outcome } from './ui';

// New job (S5a-6). The job's id and its first draft's id are made here, on the phone, and kept
// until the server answers: a lost answer is sent again with the same ids, so it can never make a
// second job (S5a-3 answers the same job). The address is locked while a send is unanswered, and
// new ids are made only after the server refused the old ones.
export function NewJobView({ session }: { session: FieldSession }) {
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState<NewJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session.capabilities.includes('jobs_create')) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">New job</h2>
        <p>Your role cannot start jobs.</p>
        <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
      </div>
    );
  }

  async function start() {
    setBusy(true);
    setError(null);
    // The same request again while one is unanswered; a new one otherwise.
    const request = pending ?? { id: crypto.randomUUID(), draftId: crypto.randomUUID(), propertyAddress: address.trim() };
    setPending(request);
    const answer = await createJob(session.user, request);
    setBusy(false);
    if (answer.ok) {
      go({ view: 'scope', jobId: answer.value.job.id });
      return;
    }
    // No answer at all: the job may be saved, so the next tap sends the same ids. A refusal is final
    // for these ids.
    if (answer.status !== 0 && answer.status < 500) setPending(null);
    setError(answer.message);
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <h2 className="text-xl font-semibold">New job</h2>
      <p className="text-base">Water or mold loss. You can add the customer and claim after.</p>
      <Box
        id="new-job-address"
        label="Property address"
        value={pending ? pending.propertyAddress : address}
        onChange={setAddress}
        readOnly={pending !== null}
        autoComplete="street-address"
        hint="Optional now; you can add it with the customer."
      />
      <Button type="submit" disabled={busy}>
        {pending && !busy ? 'Try again' : 'Start job'}
      </Button>
      <Outcome error={error} notice={busy ? 'Starting the job…' : null} />
      <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
    </form>
  );
}
