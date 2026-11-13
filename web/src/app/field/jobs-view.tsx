'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listJobs, type JobListItem } from '@/lib/field/api';
import type { FieldSession } from '@/lib/field/session';
import { defaultList, type JobsList } from '@/lib/field/views';
import { FieldLink } from './ui';

const STATUS_NAMES: Record<string, string> = {
  draft: 'In progress',
  submitted: 'Submitted',
  signed: 'Signed',
  archived: 'Archived',
};

// Jobs (S5a-6): the company's jobs or the person's own, newest first, a page at a time (S5a-3's
// GET /api/jobs). An estimator sees only their own jobs either way, so they get one list.
export function JobsView({ session, list }: { session: FieldSession; list: JobsList | null }) {
  const shown = list ?? defaultList(session.role);
  const seesCompany = session.role === 'owner' || session.role === 'office';
  const [jobs, setJobs] = useState<JobListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function apply(answer: Awaited<ReturnType<typeof listJobs>>, from: string | null) {
    setBusy(false);
    setError(answer.ok ? null : answer.message);
    if (!answer.ok) return;
    setJobs((current) => (from === null ? answer.value.jobs : [...(current ?? []), ...answer.value.jobs]));
    setCursor(answer.value.nextCursor);
  }

  async function load(from: string | null) {
    apply(await listJobs(session.user, shown, from), from);
  }

  // Each list is its own component (keyed by the parent), so it starts empty and loads once.
  useEffect(() => {
    let live = true;
    void listJobs(session.user, shown, null).then((answer) => {
      if (live) apply(answer, null);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const more = (from: string | null) => {
    setBusy(true);
    void load(from);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{shown === 'company' ? 'Company jobs' : 'My jobs'}</h2>
        {session.capabilities.includes('jobs_create') ? (
          <FieldLink to={{ view: 'new-job' }} className="rounded-md border border-foreground/40 px-4 font-medium no-underline">
            New job
          </FieldLink>
        ) : null}
      </div>
      {seesCompany ? (
        <nav aria-label="Which jobs" className="flex gap-4">
          <FieldLink to={{ view: 'jobs', list: 'company' }} current={shown === 'company'}>
            Company jobs
          </FieldLink>
          <FieldLink to={{ view: 'jobs', list: 'mine' }} current={shown === 'mine'}>
            My jobs
          </FieldLink>
        </nav>
      ) : null}
      {jobs === null && !error ? <p role="status">Loading jobs…</p> : null}
      {jobs !== null && jobs.length === 0 ? <p>No jobs yet.</p> : null}
      {jobs !== null && jobs.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={shown === 'company' ? 'Company jobs' : 'My jobs'}>
          {jobs.map((job) => (
            <li key={job.id} className="rounded-md border border-foreground/20 p-3">
              <FieldLink to={{ view: 'scope', jobId: job.id }} className="text-base font-medium">
                {job.propertyAddress || 'No address yet'}
              </FieldLink>
              <p className="text-sm">
                {job.customerName ? `${job.customerName} · ` : ''}
                {STATUS_NAMES[job.status] ?? job.status} · started {new Date(job.createdAt).toLocaleDateString()}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
        {error ?? ''}
      </p>
      {error ? (
        <Button variant="outline" onClick={() => more(jobs === null ? null : cursor)} disabled={busy}>
          Try again
        </Button>
      ) : null}
      {cursor && !error ? (
        <Button variant="outline" onClick={() => more(cursor)} disabled={busy}>
          Show more jobs
        </Button>
      ) : null}
    </div>
  );
}
