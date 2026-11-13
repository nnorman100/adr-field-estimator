'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readJob, type JobDetail } from '@/lib/field/api';
import type { FieldSession } from '@/lib/field/session';
import { canEditDraft, loadDraft, type DraftRef, type FieldDraft } from '@/lib/field/store';
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
  setDetail: (detail: JobDetail) => void;
  // Reads the job again and answers it (null when it could not be read).
  reloadJob: () => Promise<JobDetail | null>;
  // The field draft as the field database holds it; null when it could not be read.
  draft: FieldDraft | null;
  draftRef: DraftRef;
  reloadDraft: () => Promise<void>;
  // Whether this person may change the field work now (the rules' own test).
  editable: boolean;
};

// One job's screens (S5a-6): the job from the jobs API (header, customer, claim) and its field
// draft from the field database, read once and again after each save, so what is on screen is what
// is stored. Office, the owner who is not the field owner, and anyone once the draft is no longer
// being edited see the field work read-only, as the rules hold it.
export function JobScreens({ session, jobId, view }: { session: FieldSession; jobId: string; view: JobView }) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
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
      } catch {
        setDraftError('The field work could not be read just now. Check the signal and try again.');
      }
    },
    [detail, session],
  );

  const apply = useCallback(
    async (answer: Awaited<ReturnType<typeof readJob>>): Promise<JobDetail | null> => {
      setError(answer.ok ? null : answer.message);
      if (!answer.ok) return null;
      setDetail(answer.value);
      await reloadDraft(answer.value);
      return answer.value;
    },
    [reloadDraft],
  );

  const reloadJob = useCallback(async () => apply(await readJob(session.user, jobId)), [apply, session, jobId]);

  // The first read; each job is its own component (keyed by the parent).
  useEffect(() => {
    let live = true;
    void readJob(session.user, jobId).then((answer) => {
      if (live) void apply(answer);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !detail) {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert">{error}</p>
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
      {view === 'scope' && draft ? <ScopeView job={context} draft={draft} /> : null}
      {view === 'photos' && draft ? <PhotosView job={context} draft={draft} /> : null}
      {view === 'customer' ? <CustomerView job={context} /> : null}
    </div>
  );
}
