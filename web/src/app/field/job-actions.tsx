'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { archiveJob, copyJob, restoreJob, type Answer, type ArchivedJob, type JobDetail, type JobListItem } from '@/lib/field/api';
import { pending, usePending, type ArchivalKind, type PendingArchival } from '@/lib/field/pending';
import type { FieldSession } from '@/lib/field/session';
import type { JobContext } from './job-screens';
import { FieldLink, go, Outcome } from './ui';

// Archive, restore and copy (S5b-2) on the routes of docs/access/jobs.md, "Archive, restore and
// copy". All three are online only. Each request keeps the ids the phone made for it until the
// server answers (src/lib/field/pending.ts): a lost answer (or a field step that did not get through,
// 503 draft_unavailable) is sent again as it was, so it is the same change, never a second one.

export const ARCHIVE_TITLE = 'Archive this job?';
export const ARCHIVE_CONFIRM = 'Archive job';
export const ARCHIVE_KEEP = 'Keep the job';
export const ARCHIVED_TITLE = 'This job is archived';
export const COPY_LABEL = 'Copy to a new draft';

// An answer that may not have been made yet, or made only in part: the same request finishes it.
const sendAgain = (answer: { status: number; code?: string }) => answer.status === 0 || answer.status >= 500;

// The job is as the archive or restore asked, by it or by another one.
export const archivalDone = (kind: ArchivalKind, answer: Answer<ArchivedJob>) =>
  answer.ok || answer.code === (kind === 'archive' ? 'archived' : 'not_archived');

export type ArchivalAnswered = (kind: ArchivalKind, answer: Answer<ArchivedJob>) => void;

// Sends the job's archive or restore kept on this page, or else `next` with a new change id; one at a
// time. Once it is done, the job's state is posted for whichever screen or list of it is open now.
// Answers null when it was already on its way, or another request took its place.
async function sendArchival(
  session: FieldSession,
  jobId: string,
  next?: Omit<PendingArchival, 'changeId' | 'sending'>,
): Promise<Answer<ArchivedJob> | null> {
  const held = pending.archival(jobId);
  if (held?.sending) return null;
  const kept = held && (!next || held.kind === next.kind) ? held : null;
  if (!kept && !next) return null;
  const request: PendingArchival = { ...(kept ?? { ...next!, changeId: crypto.randomUUID() }), sending: true };
  pending.setArchival(jobId, request);
  const send = request.kind === 'archive' ? archiveJob : restoreJob;
  const answer = await send(session.user, jobId, { revision: request.revision, changeId: request.changeId });
  if (!pending.settleArchival(jobId, request.changeId, !answer.ok && sendAgain(answer) ? 'unanswered' : 'answered')) return null;
  if (archivalDone(request.kind, answer)) pending.archivalDone(jobId, request.kind === 'archive', answer.ok ? answer.value.job.revision : undefined);
  // An archive answered 503 draft_unavailable committed in the job's record and only its field step is
  // left: the job is archived, so the screens stop field edits now, and the same request is kept to
  // finish the draft.
  else if (request.kind === 'archive' && !answer.ok && answer.code === 'draft_unavailable') pending.archivalDone(jobId, true);
  return answer;
}

// An archive or restore of the job kept on this page (of `kind` only, when given), with its Try again.
export function UnfinishedArchival({
  session,
  jobId,
  kind,
  onAnswered,
}: {
  session: FieldSession;
  jobId: string;
  kind?: ArchivalKind;
  onAnswered?: ArchivalAnswered;
}) {
  const found = usePending(() => pending.archival(jobId));
  const held = found && (!kind || found.kind === kind) ? found : null;
  const [error, setError] = useState<string | null>(null);
  if (!held && !error) return null;

  async function again(archival: PendingArchival) {
    if (!session.online) return setError('Needs a connection');
    setError(null);
    const answer = await sendArchival(session, jobId);
    if (!answer) return;
    if (!answer.ok && !archivalDone(archival.kind, answer)) setError(answer.message);
    if (!answer.ok && sendAgain(answer)) return;
    onAnswered?.(archival.kind, answer);
  }

  return (
    <div className="flex flex-col gap-2">
      {held ? (
        <>
          <p className="text-sm">
            {held.kind === 'archive' ? 'Archiving' : 'Restoring'} this job did not finish: its field work may not be updated yet.
          </p>
          <Button variant="outline" onClick={() => void again(held)} disabled={held.sending || !session.online}>
            {held.kind === 'archive' ? 'Try archiving again' : 'Try restoring again'}
          </Button>
        </>
      ) : null}
      <Outcome error={error} notice={held?.sending ? (held.kind === 'archive' ? 'Archiving the job…' : 'Restoring…') : null} />
    </div>
  );
}

// Every archive or restore kept on this page, wherever its job now is (an archived job leaves the
// job lists, a restored one leaves Archived drafts), but those `shown` with their own Try again.
export function UnfinishedArchivals({
  session,
  shown,
  onAnswered,
}: {
  session: FieldSession;
  shown: (jobId: string, kind: ArchivalKind) => boolean;
  onAnswered: ArchivalAnswered;
}) {
  const archivals = usePending(() => pending.archivals());
  const open = Object.entries(archivals).filter(([jobId, archival]) => !shown(jobId, archival.kind));
  if (open.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Not finished">
      {open.map(([jobId, archival]) => (
        <li key={jobId} className="flex flex-col gap-2 rounded-md border border-foreground/20 p-3">
          <p className="text-base font-medium break-words">{archival.address || 'No address yet'}</p>
          <UnfinishedArchival session={session} jobId={jobId} onAnswered={onAnswered} />
        </li>
      ))}
    </ul>
  );
}

// What an archived job's screens show: the 410 of an old link, or the archive just made here.
export function ArchivedNotice({ session, jobId }: { session: FieldSession; jobId: string }) {
  return (
    <section aria-labelledby="archived-title" className="flex flex-col gap-3 rounded-md bg-foreground/5 p-3">
      <h2 id="archived-title" className="text-xl font-semibold">
        {ARCHIVED_TITLE}
      </h2>
      <p role="status" className="text-base">
        It was filed away, not deleted. It is not in the job lists, and nobody can change it. The company owner can restore it from Archived drafts.
      </p>
      {session.capabilities.includes('jobs_archive') ? <FieldLink to={{ view: 'jobs', list: 'archived' }}>Archived drafts</FieldLink> : null}
      <UnfinishedArchival session={session} jobId={jobId} />
    </section>
  );
}

// The owner's Archive of an unsigned draft (a draft or a submitted job), after a confirm dialog. A
// signed job has no archive: the action is not offered, and the server refuses it (409 job_signed).
// A native modal dialog (modern-web-guidance "dialog"): Keep has the focus, being the safe choice;
// Esc and the back gesture close it without archiving.
function ArchiveAction({ job }: { job: JobContext & { detail: JobDetail } }) {
  const { session, detail } = job;
  const dialog = useRef<HTMLDialogElement>(null);
  // The archive sent and not settled yet (src/lib/field/pending.ts): sent again with the same change id.
  const held = usePending(() => pending.archival(detail.job.id));
  const request = held?.kind === 'archive' ? held : null;
  const busy = held?.sending ?? false;
  const [error, setError] = useState<string | null>(null);

  async function archive() {
    if (!session.online) return setError('Needs a connection');
    setError(null);
    const answer = await sendArchival(session, detail.job.id, { kind: 'archive', address: detail.job.propertyAddress, revision: detail.job.revision });
    if (!answer) return;
    // Archived, by this request or an earlier one: the screens follow it.
    if (answer.ok || answer.code === 'archived') return;
    if (sendAgain(answer)) return setError(answer.message);
    if (answer.denied) return job.refuse({ status: answer.status, message: answer.message });
    if (answer.stale) {
      setError('This job changed since it was opened. It is read again: check it, then archive it again.');
      void job.reloadJob();
      return;
    }
    setError(answer.message);
    // Signed since it was opened: read again, it then offers Copy instead.
    if (answer.code === 'job_signed') void job.reloadJob();
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">A test or a duplicate draft can be filed away. Nothing is deleted, and you can restore it from Archived drafts.</p>
      <Button variant="outline" onClick={() => dialog.current?.showModal()} disabled={busy || !session.online}>
        {request && !busy ? 'Try archiving again' : ARCHIVE_CONFIRM}
      </Button>
      {!session.online ? <p role="status">Needs a connection</p> : null}
      <Outcome error={error} notice={busy ? 'Archiving the job…' : null} />
      <dialog
        ref={dialog}
        aria-labelledby="archive-title"
        aria-describedby="archive-text"
        onClose={(event) => {
          const value = event.currentTarget.returnValue;
          event.currentTarget.returnValue = '';
          if (value === 'archive') void archive();
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md overscroll-contain rounded-2xl border border-input bg-background p-6 text-foreground backdrop:overflow-hidden backdrop:overscroll-contain backdrop:bg-black/40"
      >
        <h2 id="archive-title" className="text-xl font-semibold">
          {ARCHIVE_TITLE}
        </h2>
        <p id="archive-text" className="mt-3 text-base">
          It leaves the job lists, and its link shows it as archived. Nobody can change it while it is archived. A signing link sent for it stops working.
          Nothing is deleted: you can restore it from Archived drafts.
        </p>
        <form method="dialog" className="mt-4 flex flex-col gap-2">
          <Button autoFocus variant="outline" value="">
            {ARCHIVE_KEEP}
          </Button>
          <Button value="archive">{ARCHIVE_CONFIRM}</Button>
        </form>
      </dialog>
    </div>
  );
}

// Copy a signed job to a new draft, in one tap. The new job's and draft's ids are made here and kept
// (src/lib/field/pending.ts) until the server answers, so a copy sent again after a lost answer makes
// one draft, even after leaving this screen and coming back.
function CopyAction({ job }: { job: JobContext & { detail: JobDetail } }) {
  const { session, jobId } = job;
  const unsent = usePending(() => pending.copy(jobId));
  const busy = unsent?.sending ?? false;
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    if (!session.online) return setError('Needs a connection');
    const held = pending.copy(jobId);
    if (held?.sending) return;
    setError(null);
    const request = { ...(held ?? { id: crypto.randomUUID(), draftId: crypto.randomUUID() }), sending: true };
    pending.setCopy(jobId, request);
    const answer = await copyJob(session.user, jobId, { id: request.id, draftId: request.draftId });
    const again = !answer.ok && sendAgain(answer);
    if (!pending.settleCopy(jobId, request.id, again ? 'unanswered' : 'answered')) return;
    if (answer.ok) {
      // As a new job: whoever does field work goes on to its scope, office to its coordination.
      go({ view: session.capabilities.includes('scope') ? 'scope' : 'coordination', jobId: answer.value.job.id });
      return;
    }
    setError(answer.message);
    if (answer.denied) job.refuse({ status: answer.status, message: answer.message });
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        Starts a new draft job with this job&rsquo;s address, rooms and scope, to be confirmed again. The customer, the claim and the photos stay with
        the signed job.
      </p>
      <Button variant="outline" onClick={() => void copy()} disabled={busy || !session.online}>
        {unsent && !busy ? 'Try copying again' : COPY_LABEL}
      </Button>
      {!session.online ? <p role="status">Needs a connection</p> : null}
      <Outcome error={error} notice={busy ? 'Copying the job…' : null} />
    </div>
  );
}

// The job's own actions, under its screens: Archive (the owner, an unsigned draft) or Copy (a signed
// job). A restore of the job not settled yet is finished first.
export function JobActions({ job }: { job: JobContext & { detail: JobDetail } }) {
  const { status } = job.detail.job;
  const capabilities = job.session.capabilities;
  const restoring = usePending(() => pending.archival(job.jobId)?.kind === 'restore');
  const archivable = capabilities.includes('jobs_archive') && (status === 'draft' || status === 'submitted');
  const copyable = capabilities.includes('jobs_copy') && status === 'signed';
  return (
    <section aria-label="Job actions" className="flex flex-col gap-3 border-t border-foreground/20 pt-4 empty:hidden">
      <UnfinishedArchival session={job.session} jobId={job.jobId} kind="restore" />
      {archivable && !restoring ? <ArchiveAction job={job} /> : null}
      {copyable ? <CopyAction job={job} /> : null}
    </section>
  );
}

// One row of the owner's Archived drafts, with Restore. The restore is kept with its change id until
// the server settles it, as the archive is (src/lib/field/pending.ts).
export function ArchivedRow({
  session,
  job,
  onRestored,
  onStale,
}: {
  session: FieldSession;
  job: JobListItem;
  onRestored: (restored: ArchivedJob['job'] | null) => void;
  onStale: () => void;
}) {
  const held = usePending(() => pending.archival(job.id));
  const request = held?.kind === 'restore' ? held : null;
  const busy = held?.sending ?? false;
  const [error, setError] = useState<string | null>(null);
  const address = job.propertyAddress || 'No address yet';
  const addressId = useId();

  async function restore() {
    if (!session.online) return setError('Needs a connection');
    setError(null);
    const answer = await sendArchival(session, job.id, { kind: 'restore', address: job.propertyAddress, revision: job.revision });
    if (!answer) return;
    if (answer.ok) return onRestored(answer.value.job);
    if (sendAgain(answer)) return setError(answer.message);
    // Restored already, by another request: it is no longer an archived draft.
    if (answer.code === 'not_archived') return onRestored(null);
    if (answer.stale) {
      setError('This job changed since the list was read. The list is read again.');
      return onStale();
    }
    setError(answer.message);
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-foreground/20 p-3">
      <p id={addressId} className="text-base font-medium break-words">
        {address}
      </p>
      <p className="text-sm">
        {job.customerName ? `${job.customerName} · ` : ''}Archived · started {new Date(job.createdAt).toLocaleDateString()}
      </p>
      <Button variant="outline" onClick={() => void restore()} disabled={busy || !session.online} aria-describedby={addressId}>
        {request && !busy ? 'Try restoring again' : 'Restore'}
      </Button>
      <Outcome error={error} notice={busy ? 'Restoring…' : null} />
    </li>
  );
}
