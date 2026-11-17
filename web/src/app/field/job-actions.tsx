'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { archiveJob, copyJob, restoreJob, type ArchiveSave, type ArchivedJob, type JobDetail, type JobListItem } from '@/lib/field/api';
import { pending, usePending } from '@/lib/field/pending';
import type { FieldSession } from '@/lib/field/session';
import type { JobContext } from './job-screens';
import { FieldLink, go, Outcome } from './ui';

// Archive, restore and copy (S5b-2) on the routes of docs/access/jobs.md, "Archive, restore and
// copy". All three are online only. Each request keeps the ids the phone made for it until the
// server answers: a lost answer (or a field step that did not get through, 503 draft_unavailable) is
// sent again as it was, so it is the same change, never a second one.

export const ARCHIVE_TITLE = 'Archive this job?';
export const ARCHIVE_CONFIRM = 'Archive job';
export const ARCHIVE_KEEP = 'Keep the job';
export const ARCHIVED_TITLE = 'This job is archived';
export const COPY_LABEL = 'Copy to a new draft';

// An answer that may not have been made yet, or made only in part: the same request finishes it.
const sendAgain = (answer: { status: number; code?: string }) => answer.status === 0 || answer.status >= 500;

// What an archived job's screens show: the 410 of an old link, or the archive just made here.
export function ArchivedNotice({ session, address }: { session: FieldSession; address: string | null }) {
  return (
    <div className="flex flex-col gap-3">
      <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
      <h2 className="text-xl font-semibold">{ARCHIVED_TITLE}</h2>
      {address ? <p className="text-base break-words">{address}</p> : null}
      <p role="status" className="rounded-md bg-foreground/5 p-3 text-base">
        It was filed away, not deleted. It is not in the job lists, and nobody can change it. The company owner can restore it from Archived drafts.
      </p>
      {session.capabilities.includes('jobs_archive') ? <FieldLink to={{ view: 'jobs', list: 'archived' }}>Archived drafts</FieldLink> : null}
    </div>
  );
}

// The owner's Archive of an unsigned draft (a draft or a submitted job), after a confirm dialog. A
// signed job has no archive: the action is not offered, and the server refuses it (409 job_signed).
// A native modal dialog (modern-web-guidance "dialog"): Keep has the focus, being the safe choice;
// Esc and the back gesture close it without archiving.
function ArchiveAction({ job, onArchived }: { job: JobContext & { detail: JobDetail }; onArchived: () => void }) {
  const { session, detail } = job;
  const dialog = useRef<HTMLDialogElement>(null);
  // The archive sent and not answered yet: sent again with the same change id.
  const [request, setRequest] = useState<ArchiveSave | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function archive() {
    if (!session.online) return setError('Needs a connection');
    const sent = request ?? { revision: detail.job.revision, changeId: crypto.randomUUID() };
    setRequest(sent);
    setBusy(true);
    setError(null);
    const answer = await archiveJob(session.user, detail.job.id, sent);
    setBusy(false);
    // Archived, by this request or an earlier one.
    if (answer.ok || answer.code === 'archived') {
      setRequest(null);
      return onArchived();
    }
    if (sendAgain(answer)) return setError(answer.message);
    setRequest(null);
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

// The job's own actions, under its screens: Archive (the owner, an unsigned draft) or Copy (a signed job).
export function JobActions({ job, onArchived }: { job: JobContext & { detail: JobDetail }; onArchived: () => void }) {
  const { status } = job.detail.job;
  const capabilities = job.session.capabilities;
  const archivable = capabilities.includes('jobs_archive') && (status === 'draft' || status === 'submitted');
  const copyable = capabilities.includes('jobs_copy') && status === 'signed';
  if (!archivable && !copyable) return null;
  return (
    <section aria-label="Job actions" className="flex flex-col gap-3 border-t border-foreground/20 pt-4">
      {archivable ? <ArchiveAction job={job} onArchived={onArchived} /> : null}
      {copyable ? <CopyAction job={job} /> : null}
    </section>
  );
}

// One row of the owner's Archived drafts, with Restore. The restore is kept with its change id until
// the server answers, as the archive is.
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
  const [request, setRequest] = useState<ArchiveSave | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = job.propertyAddress || 'No address yet';
  const addressId = useId();

  async function restore() {
    if (!session.online) return setError('Needs a connection');
    const sent = request ?? { revision: job.revision, changeId: crypto.randomUUID() };
    setRequest(sent);
    setBusy(true);
    setError(null);
    const answer = await restoreJob(session.user, job.id, sent);
    setBusy(false);
    if (answer.ok) return onRestored(answer.value.job);
    if (sendAgain(answer)) return setError(answer.message);
    setRequest(null);
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
