'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { createJob } from '@/lib/field/api';
import { pending, usePending } from '@/lib/field/pending';
import type { FieldSession } from '@/lib/field/session';
import { Box, FieldLink, go, Outcome } from './ui';

// New job (S5a-6). The job's id and its first draft's id are made here, on the phone, and kept
// (src/lib/field/pending.ts) until the server answers: a lost answer is sent again with the same
// ids, so it can never make a second job (S5a-3 answers the same job), even after leaving this
// screen and coming back. The address is locked while a send is unanswered, and new ids are made
// only after the server refused the old ones.
export function NewJobView({ session }: { session: FieldSession }) {
  const [address, setAddress] = useState('');
  const unsent = usePending(pending.job);
  // In flight is kept with the request itself, so a screen opened again while it is on its way waits.
  const busy = unsent?.sending ?? false;
  // A refused start, kept until the person changes the address or starts again: the address they
  // entered goes back in its box with the server's reason.
  const refusal = usePending(pending.jobRefusal);
  const [error, setError] = useState<string | null>(null);
  const typed = refusal?.propertyAddress ?? address;

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
    if (!session.online) return setError('Needs a connection');
    const held = pending.job();
    if (held?.sending) return;
    setError(null);
    pending.dropJobRefusal();
    setAddress(typed);
    // The same request again while one is unanswered; a new one otherwise.
    const request = { ...(held ?? { id: crypto.randomUUID(), draftId: crypto.randomUUID(), propertyAddress: typed.trim() }), sending: true };
    pending.setJob(request);
    const answer = await createJob(session.user, { id: request.id, draftId: request.draftId, propertyAddress: request.propertyAddress });
    // No answer at all: the job may be saved, so the next tap sends the same ids. A refusal is final
    // for these ids, and the address goes back in its box.
    const refused = !answer.ok && answer.status !== 0 && answer.status < 500;
    const settlement = answer.ok ? 'answered' : refused ? { refused: answer.message } : 'unanswered';
    if (!pending.settleJob(request.id, settlement)) return;
    if (answer.ok) {
      go({ view: 'scope', jobId: answer.value.job.id });
      return;
    }
    if (!refused) setError(answer.message);
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
        value={unsent ? unsent.propertyAddress : typed}
        onChange={(value) => {
          if (refusal) {
            pending.dropJobRefusal();
            setError(refusal.message);
          }
          setAddress(value);
        }}
        readOnly={unsent !== null}
        autoComplete="street-address"
        hint="Optional now; you can add it with the customer."
      />
      <Button type="submit" disabled={busy || !session.online}>
        {unsent && !busy ? 'Try again' : 'Start job'}
      </Button>
      {!session.online ? <p role="status">Needs a connection</p> : null}
      {unsent && !busy && !error ? <p role="status">This job was sent but no answer came back. Try again to finish it.</p> : null}
      <Outcome error={error ?? refusal?.message ?? null} notice={busy ? 'Starting the job…' : null} />
      <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
    </form>
  );
}
