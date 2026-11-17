'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listJobs, type JobListItem } from '@/lib/field/api';
import type { FieldSession } from '@/lib/field/session';
import { defaultList, type JobsList } from '@/lib/field/views';
import { archivalDone, ArchivedRow, UnfinishedArchivals } from './job-actions';
import { FieldLink } from './ui';

const STATUS_NAMES: Record<string, string> = {
  draft: 'In progress',
  submitted: 'Submitted',
  signed: 'Signed',
  archived: 'Archived',
};

const TITLES: Record<JobsList, string> = { company: 'Company jobs', mine: 'My jobs', archived: 'Archived drafts' };

// Jobs (S5a-6): the company's jobs or the person's own, newest first, a page at a time (S5a-3's
// GET /api/jobs). An estimator sees only their own jobs either way, so they get one list. The owner
// also has Archived drafts (S5b-2), the only list that holds archived jobs, each with Restore, and on
// every list the archives and restores of this page that did not finish, wherever their jobs now are.
export function JobsView({ session, list }: { session: FieldSession; list: JobsList | null }) {
  const shown = list ?? defaultList(session.role);
  const seesCompany = session.role === 'owner' || session.role === 'office';
  const seesArchived = session.capabilities.includes('jobs_archive');
  const archivedList = shown === 'archived';
  // The job restored last from Archived drafts, to open from here.
  const [restored, setRestored] = useState<{ id: string; address: string } | null>(null);
  // Why an unfinished archive or restore sent again from here was refused.
  const [refused, setRefused] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; from: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the newest request answers: a page asked for before the list was read again from its first
  // page is not added to it, and no page is asked for until that first page is back.
  const latest = useRef(0);

  function apply(answer: Awaited<ReturnType<typeof listJobs>>, from: string | null) {
    setBusy(false);
    if (!answer.ok) {
      setError({ message: answer.message, from: answer.denied ? null : from });
      // A refusal to list jobs drops the ones already shown.
      if (answer.denied) {
        setJobs(null);
        setCursor(null);
      }
      return;
    }
    setError(null);
    setJobs((current) => (from === null ? answer.value.jobs : [...(current ?? []), ...answer.value.jobs]));
    setCursor(answer.value.nextCursor);
  }

  async function load(from: string | null) {
    if (!session.online) return;
    const mine = ++latest.current;
    const answer = await listJobs(session.user, shown, from);
    if (mine === latest.current) apply(answer, from);
  }

  // Each list is its own component (keyed by the parent), so it starts empty and loads once, and
  // again from its first page each time the connection comes back.
  useEffect(() => {
    if (!session.online) return;
    void load(null);
    return () => {
      latest.current += 1;
      setBusy(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.online]);

  const more = (from: string | null) => {
    setBusy(true);
    void load(from);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{TITLES[shown]}</h2>
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
          {seesArchived ? (
            <FieldLink to={{ view: 'jobs', list: 'archived' }} current={archivedList}>
              Archived drafts
            </FieldLink>
          ) : null}
        </nav>
      ) : null}
      {!session.online ? <p role="status">Needs a connection</p> : null}
      {session.online && jobs === null && !error ? <p role="status">Loading jobs…</p> : null}
      {restored ? (
        <p role="status" className="text-sm">
          Restored: it is back in the job lists.{' '}
          <FieldLink to={{ view: 'scope', jobId: restored.id }}>Open {restored.address}</FieldLink>
        </p>
      ) : null}
      {seesArchived ? (
        <UnfinishedArchivals
          session={session}
          shown={(jobId, kind) => archivedList && kind === 'restore' && (jobs ?? []).some((job) => job.id === jobId)}
          onAnswered={(kind, answer) => {
            setRefused(archivalDone(kind, answer) || answer.ok ? null : answer.message);
            if (kind === 'restore' && answer.ok) setRestored({ id: answer.value.job.id, address: answer.value.job.propertyAddress || 'No address yet' });
            more(null);
          }}
        />
      ) : null}
      {refused ? (
        <p role="alert" className="text-sm font-medium text-red-800">
          {refused}
        </p>
      ) : null}
      {jobs !== null && jobs.length === 0 ? <p>{archivedList ? 'No archived drafts.' : 'No jobs yet.'}</p> : null}
      {archivedList && jobs !== null && jobs.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={TITLES.archived}>
          {jobs.map((job) => (
            <ArchivedRow
              key={job.id}
              session={session}
              job={job}
              onRestored={(back) => {
                setJobs((current) => (current ?? []).filter((one) => one.id !== job.id));
                setRestored(back ? { id: back.id, address: back.propertyAddress || 'No address yet' } : null);
              }}
              onStale={() => more(null)}
            />
          ))}
        </ul>
      ) : null}
      {!archivedList && jobs !== null && jobs.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={TITLES[shown]}>
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
        {error?.message ?? ''}
      </p>
      {error ? (
        <Button variant="outline" onClick={() => more(error.from)} disabled={busy || !session.online}>
          Try again
        </Button>
      ) : null}
      {cursor && !error ? (
        <Button variant="outline" onClick={() => more(cursor)} disabled={busy || !session.online}>
          Show more jobs
        </Button>
      ) : null}
    </div>
  );
}
