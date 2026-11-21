'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { claimFieldOwner, type JobDetail } from '@/lib/field/api';
import type { JobContext } from './job-screens';
import { Outcome } from './ui';

// "First capture makes me field owner" (S5b-1, docs/spec.md 6.2): on a job nobody owns in the field
// yet, the first person who does field work starts it and owns it from then on; the server sets the
// draft's field owner, and the job and its draft are read again. Sent again after no answer it is the
// same request: the server answers the same person with the same job. (A job whose field work is already
// this person's but whose draft is not ready is got ready by the job read, job-screens.tsx.)
export function StartFieldWork({ context }: { context: JobContext & { detail: JobDetail } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy) return;
    if (!context.session.online) return setError('Needs a connection');
    setBusy(true);
    setError(null);
    const answer = await claimFieldOwner(context.session.user, context.jobId);
    setBusy(false);
    if (answer.ok) {
      // The draft now names this person as its field owner: read it again.
      await context.reloadJob();
      return;
    }
    setError(answer.message);
    // Archived (410), or refused (401, 403: a member disabled, a company suspended): the job is shown
    // archived, or dropped from the screen, as any refusal of it is (checkAccess). Someone else started it
    // meanwhile, the job moved on, or the job was saved and its draft was not (503): read it again, which
    // decides what the screen offers.
    if (answer.status === 410 || answer.status === 403 || answer.status === 401) context.checkAccess(answer);
    else if (answer.status === 409 || answer.status === 404 || answer.status === 503) await context.reloadJob();
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-foreground/5 p-3">
      <p className="text-sm">Nobody has started this job’s field work yet. Whoever starts it owns it: only they can change it from then on.</p>
      <Button onClick={() => void start()} disabled={busy || !context.session.online}>
        {busy ? 'Starting…' : 'Start field work'}
      </Button>
      <Outcome error={error} notice={null} />
    </div>
  );
}
