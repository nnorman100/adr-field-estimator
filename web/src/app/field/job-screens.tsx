'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readJob, type JobDetail } from '@/lib/field/api';
import { newerDetail, pending, usePending } from '@/lib/field/pending';
import type { FieldSession } from '@/lib/field/session';
import { canEditDraft, InvalidFieldData, loadDraft, type DraftRef, type FieldDraft } from '@/lib/field/store';
import type { JobView } from '@/lib/field/views';
import { CustomerView } from './customer-view';
import { PhotosView } from './photos-view';
import { ScopeView } from './scope-view';
import { FieldLink } from './ui';

const TABS: { view: JobView; label: string }[] = [
  { view: 'scope', label: 'Check Scope' },
  { view: 'customer', label: 'Customer and claim' },
  { view: 'photos', label: 'Photos' },
];

export type JobContext = {
  session: FieldSession;
  detail: JobDetail;
  // Keeps a job answered to a request made under `mark` (src/lib/field/pending.ts).
  setDetail: (detail: JobDetail, mark: number) => void;
  // Reads the job again and answers it (null when it could not be read).
  reloadJob: () => Promise<JobDetail | null>;
  // The field draft as the field database holds it; null when it could not be read.
  draft: FieldDraft | null;
  draftRef: DraftRef;
  reloadDraft: () => Promise<void>;
  // Whether this person may change the field work now (the rules' own test).
  editable: boolean;
  // The last read of the draft did not get through, so the draft on screen may be older than what is
  // stored: boxes stay open, but nothing is saved over it until it is read again.
  stale: boolean;
};


// One job's screens (S5a-6): the job from the jobs API (header, customer, claim) and its field
// draft from the field database, read once and again after each save, so what is on screen is what
// is stored. Office, the owner who is not the field owner, and anyone once the draft is no longer
// being edited see the field work read-only, as the rules hold it.
export function JobScreens({ session, jobId, view }: { session: FieldSession; jobId: string; view: JobView }) {
  const [read, setRead] = useState<{ detail: JobDetail; mark: number } | null>(null);
  // A save that settled after an earlier screen of this job closed posts the job it got back
  // (src/lib/field/pending.ts); the newer of that and this screen's own read is the job shown. Once
  // the server refuses the job to this person, in this screen or another, neither is shown.
  const posted = usePending(() => pending.detail(jobId));
  const mark = usePending(() => pending.mark(jobId));
  const denial = usePending(() => pending.denial(jobId));
  const detail = newerDetail(read?.mark === mark ? read.detail : null, posted);
  const setDetail = useCallback(
    (next: JobDetail, sentAt: number) => {
      if (pending.publishDetail(jobId, next, sentAt)) setRead({ detail: next, mark: sentAt });
    },
    [jobId],
  );
  const draftChanges = usePending(() => pending.draftChanges(jobId));
  const [draft, setDraft] = useState<FieldDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const reloadDraft = useCallback(
    async (current?: JobDetail) => {
      const job = current ?? detail;
      if (!job || !session.db) return;
      try {
        const found = await loadDraft(session.db, { companyId: session.companyId, draftId: job.job.currentDraftId });
        setDraft(found);
        setDraftError(found ? null : 'The field work of this job is not there yet. Try again in a moment.');
      } catch (error) {
        // A read that did not get through keeps the draft as last read on screen, and with it any
        // boxes the person has changed and not saved; field work the app cannot read is not shown.
        if (!(error instanceof InvalidFieldData)) {
          setDraftError('The field work could not be read just now. Check the signal and try again.');
          return;
        }
        setDraft(null);
        setDraftError(
          'Part of this job’s field work is stored in a form this app cannot read, so it is not shown. Ask the office to check this job.',
        );
      }
    },
    [detail, session],
  );

  const apply = useCallback(
    async (answer: Awaited<ReturnType<typeof readJob>>, sentAt: number): Promise<JobDetail | null> => {
      if (sentAt !== pending.mark(jobId)) return null;
      setError(answer.ok ? null : answer.message);
      if (!answer.ok) {
        // A refusal to show the job drops every copy of it; no answer keeps the one on screen.
        if (answer.denied) {
          pending.denyDetail(jobId, answer.message);
          setDraft(null);
        }
        return null;
      }
      setDetail(answer.value, sentAt);
      await reloadDraft(answer.value);
      return answer.value;
    },
    [reloadDraft, setDetail, jobId],
  );

  const reloadJob = useCallback(async () => {
    const sentAt = pending.mark(jobId);
    return apply(await readJob(session.user, jobId), sentAt);
  }, [apply, session, jobId]);

  // The first read; each job is its own component (keyed by the parent).
  useEffect(() => {
    let live = true;
    const sentAt = pending.mark(jobId);
    void readJob(session.user, jobId).then((answer) => {
      if (live) void apply(answer, sentAt);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A photo that settled after an earlier screen of this job closed changed the draft: read it again.
  useEffect(() => {
    // Read after this render, as an answer to the change the store posted.
    if (draftChanges > 0) void Promise.resolve().then(() => reloadDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftChanges]);

  if ((error || denial) && !detail) {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert">{error ?? denial}</p>
        <Button variant="outline" onClick={() => void reloadJob()}>
          Try again
        </Button>
        <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
      </div>
    );
  }
  if (!detail) return <p role="status">Opening the job…</p>;

  const context: JobContext = {
    session,
    detail,
    setDetail,
    reloadJob,
    draft,
    draftRef: { companyId: session.companyId, draftId: detail.job.currentDraftId },
    reloadDraft: () => reloadDraft(detail),
    editable: draft !== null && canEditDraft(draft, session.user.uid, session.capabilities),
    stale: draft !== null && draftError !== null,
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
      <h2 className="text-xl font-semibold break-words">{detail.job.propertyAddress || 'No address yet'}</h2>
      <nav aria-label="Job" className="flex flex-wrap gap-x-4">
        {TABS.map((tab) => (
          <FieldLink key={tab.view} to={{ view: tab.view, jobId }} current={tab.view === view} className={tab.view === view ? 'font-semibold' : undefined}>
            {tab.label}
          </FieldLink>
        ))}
      </nav>
      {(view === 'scope' || view === 'photos') && draft !== null && !context.editable ? (
        <p className="rounded-md bg-foreground/5 p-3 text-sm">
          Read only. Only the estimator who owns this job&rsquo;s field work changes it, while the job is being edited.
        </p>
      ) : null}
      {(view === 'scope' || view === 'photos') && !session.db ? (
        <p role="alert">The field database is not set up for this company yet.</p>
      ) : null}
      {(view === 'scope' || view === 'photos') && draftError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{draftError}</p>
          <Button variant="outline" onClick={() => void reloadDraft(detail)}>
            Try again
          </Button>
        </div>
      ) : null}
      {/* The views of one job stay mounted and only the open one shows, so moving between them
          keeps what the person has typed and not saved. */}
      <div hidden={view !== 'scope'}>{draft ? <ScopeView job={context} draft={draft} /> : null}</div>
      <div hidden={view !== 'photos'}>{draft ? <PhotosView job={context} draft={draft} open={view === 'photos'} /> : null}</div>
      <div hidden={view !== 'customer'}>
        <CustomerView job={context} />
      </div>
    </div>
  );
}
