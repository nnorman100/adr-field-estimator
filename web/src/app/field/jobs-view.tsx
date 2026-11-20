'use client';

import { useEffect, useRef, useState } from 'react';
import { pending, usePending } from '@/lib/field/pending';
import { Button } from '@/components/ui/button';
import { listJobs, type JobListItem } from '@/lib/field/api';
import type { FieldSession } from '@/lib/field/session';
import { defaultList, type JobsList } from '@/lib/field/views';
import { JOB_STATUS_LABELS } from '@/lib/jobs/status-labels';
import { markerText } from '@/lib/readiness/client';
import { archivalDone, ArchivedRow, UnfinishedArchivals } from './job-actions';
import { useReadinessMarkers } from './readiness-markers';
import { FieldLink } from './ui';

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
  // The server refused a list (a suspended company, a removed member): nothing with a property
  // address stays on screen, and archive answers that arrive meanwhile are not shown, until a list
  // read is answered again. Kept for the page (src/lib/field/pending.ts), so a list opened again
  // does not show them before its own answer.
  const denied = usePending(() => pending.listDenied());
  const rows = denied ? null : jobs;
  const markers = useReadinessMarkers(session.user, session.online && session.readiness && !archivedList ? rows : null, session.capabilities);
  // Only the newest request answers: a page asked for before the list was read again from its first
  // page is not added to it, and no page is asked for until that first page is back.
  const latest = useRef(0);

  function apply(answer: Awaited<ReturnType<typeof listJobs>>, from: string | null) {
    setBusy(false);
    if (!answer.ok) {
      setError({ message: answer.message, from: answer.denied ? null : from });
      // A refusal to list jobs drops the ones already shown, and with them the restored job and the
      // unfinished archives, which name properties too.
      if (answer.denied) {
        setJobs(null);
        setCursor(null);
        setRestored(null);
        setRefused(null);
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
    const sent = pending.listSend();
    const answer = await listJobs(session.user, shown, from);
    if (answer.ok || answer.denied) pending.listAnswered(sent, !answer.ok);
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

  // An archive or restore done on this page, from this list or any screen, moves its job between the
  // lists: read this one again from its first page.
  const archivalsDone = usePending(() => pending.archivalsDone());
  const [archivalsSeen] = useState(archivalsDone);
  useEffect(() => {
    if (archivalsDone !== archivalsSeen) void Promise.resolve().then(() => more(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archivalsDone]);

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
      {session.online && rows === null && !error ? <p role="status">Loading jobs…</p> : null}
      {restored && !denied ? (
        <p role="status" className="text-sm">
          Restored: it is back in the job lists.{' '}
          <FieldLink to={{ view: 'scope', jobId: restored.id }}>Open {restored.address}</FieldLink>
        </p>
      ) : null}
      {seesArchived && !denied ? (
        <UnfinishedArchivals
          session={session}
          shown={(jobId, kind) => archivedList && kind === 'restore' && (rows ?? []).some((job) => job.id === jobId)}
          onAnswered={(kind, answer) => {
            if (pending.listDenied()) return;
            setRefused(archivalDone(kind, answer) || answer.ok ? null : answer.message);
            if (kind === 'restore' && answer.ok) setRestored({ id: answer.value.job.id, address: answer.value.job.propertyAddress || 'No address yet' });
            if (!archivalDone(kind, answer)) more(null);
          }}
        />
      ) : null}
      {refused ? (
        <p role="alert" className="text-sm font-medium text-red-800">
          {refused}
        </p>
      ) : null}
      {rows !== null && rows.length === 0 ? <p>{archivedList ? 'No archived drafts.' : 'No jobs yet.'}</p> : null}
      {archivedList && rows !== null && rows.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={TITLES.archived}>
          {rows.map((job) => (
            <ArchivedRow
              key={job.id}
              session={session}
              job={job}
              onRestored={(back) => {
                if (pending.listDenied()) return;
                setJobs((current) => (current ?? []).filter((one) => one.id !== job.id));
                setRestored(back ? { id: back.id, address: back.propertyAddress || 'No address yet' } : null);
              }}
              onStale={() => more(null)}
            />
          ))}
        </ul>
      ) : null}
      {!archivedList && rows !== null && rows.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={TITLES[shown]}>
          {rows.map((job) => {
            const marker = markers?.get(job.id);
            return (
              <li key={job.id} className="rounded-md border border-foreground/20 p-3">
                <FieldLink to={{ view: 'scope', jobId: job.id }} className="text-base font-medium">
                  {job.propertyAddress || 'No address yet'}
                </FieldLink>
                <p className="text-sm">
                  {job.customerName ? `${job.customerName} · ` : ''}
                  {JOB_STATUS_LABELS[job.status]} · started {new Date(job.createdAt).toLocaleDateString()}
                </p>
                {marker ? <p className="text-sm font-medium">{markerText(marker)}</p> : null}
              </li>
            );
          })}
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
      {cursor && !denied && !error ? (
        <Button variant="outline" onClick={() => more(cursor)} disabled={busy || !session.online}>
          Show more jobs
        </Button>
      ) : null}
    </div>
  );
}
