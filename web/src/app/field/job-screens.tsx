'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readJob, type JobDetail, type Refusal } from '@/lib/field/api';
import { loadJobProjection, type JobProjection } from '@/lib/field/job-projection';
import { newerDetail, pending, usePending } from '@/lib/field/pending';
import type { FieldSession } from '@/lib/field/session';
import { canEditDraft, fieldRefusal, InvalidFieldData, loadDraft, type DraftRef, type FieldDraft } from '@/lib/field/store';
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
  detail: JobDetail | null;
  jobId: string;
  // Keeps a job answered to a request made under `mark` (src/lib/field/pending.ts).
  setDetail: (detail: JobDetail, mark: number) => void;
  // Reads the job again and answers it (null when it could not be read).
  reloadJob: () => Promise<JobDetail | null>;
  // The field draft as the field database holds it; null when it could not be read.
  draft: FieldDraft | null;
  draftRef: DraftRef;
  reloadDraft: (source?: 'cache') => Promise<void>;
  // Takes a refusal of the photo route or the field database (null for none): 401 or 403 drops the
  // job from the screen; a 404 may be a missing photo, so the job is read again and that decides.
  checkAccess: (refusal: Refusal | null) => void;
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
  const [locator, setLocator] = useState<JobProjection | null>(null);
  const [cachedError, setCachedError] = useState<string | null>(null);
  const [draft, setDraft] = useState<FieldDraft | null>(null);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  // The server refused the job to this person: every copy of it goes (src/lib/field/pending.ts).
  const deny = useCallback(
    (message: string) => {
      pending.denyDetail(jobId, message);
      setDraft(null);
    },
    [jobId],
  );

  const reloadDraft = useCallback(
    async (currentDraftId?: string, source?: 'cache') => {
      const draftId = currentDraftId ?? locator?.currentDraftId ?? detail?.job.currentDraftId;
      if (!draftId || !session.db) return;
      try {
        const found = await loadDraft(session.db, { companyId: session.companyId, draftId }, source);
        setDraftAt(draftId);
        setDraft(found);
        setDraftError(found ? null : 'The field work of this job is not there yet. Try again in a moment.');
      } catch (error) {
        const refusal = fieldRefusal(error);
        if (refusal) return deny(refusal.message);
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
    [detail, locator, session, deny],
  );

  // The locator first, then the draft it names; trying again repeats both.
  const openDraft = useCallback(async () => {
    try {
      // The API populated this server-owned locator, including for jobs made before S6. Read
      // the document itself to warm the person cache; never cache the API response.
      const head = await loadJobProjection(session.db, session.companyId, jobId);
      if (!head) throw new Error('Job locator unavailable');
      setLocator(head);
      setCachedError(null);
      await reloadDraft(head.currentDraftId);
    } catch (error) {
      const refusal = fieldRefusal(error);
      if (refusal) deny(refusal.message);
      else setDraftError('The field work could not be opened. Try again when connected.');
    }
  }, [reloadDraft, jobId, session, deny]);

  const apply = useCallback(
    async (answer: Awaited<ReturnType<typeof readJob>>, sentAt: number): Promise<JobDetail | null> => {
      if (!pending.readAnswered(jobId, answer, sentAt)) return null;
      setError(answer.ok ? null : answer.message);
      if (!answer.ok) {
        // A refusal to show the job drops every copy of it; no answer keeps the one on screen.
        if (answer.denied) setDraft(null);
        return null;
      }
      setDetail(answer.value, sentAt);
      await openDraft();
      return answer.value;
    },
    [openDraft, setDetail, jobId],
  );

  const reloadJob = useCallback(async () => {
    if (!session.online) return null;
    const sentAt = pending.mark(jobId);
    return apply(await readJob(session.user, jobId), sentAt);
  }, [apply, session, jobId]);

  const checkAccess = useCallback(
    (refusal: Refusal | null) => {
      if (!refusal) return;
      if (refusal.status === 401 || refusal.status === 403) return deny(refusal.message);
      if (refusal.status !== 404) return;
      const sentAt = pending.mark(jobId);
      void readJob(session.user, jobId).then((answer) => {
        if (pending.readAnswered(jobId, answer, sentAt) && !answer.ok && answer.denied) setDraft(null);
      });
    },
    [deny, jobId, session.user],
  );

  // The first read; each job is its own component (keyed by the parent).
  useEffect(() => {
    if (!session.online) return;
    let live = true;
    const sentAt = pending.mark(jobId);
    void readJob(session.user, jobId).then((answer) => {
      // A refusal that comes back after this screen closed still drops the job for the next one.
      if (live) void apply(answer, sentAt);
      else pending.readAnswered(jobId, answer, sentAt);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.online]);

  // An offline start needs only the locator and field maps already in this person's cache, also
  // when a job read earlier on this page is still shown. The gate still owns all network access
  // and retention. No SQL job/customer/claim is invented.
  useEffect(() => {
    if (session.online || draft || denial) return;
    let live = true;
    void (async () => {
      try {
        const head = await loadJobProjection(session.db, session.companyId, jobId, 'cache');
        if (!head) throw new Error('Job not kept on this phone');
        const found = await loadDraft(session.db, { companyId: session.companyId, draftId: head.currentDraftId }, 'cache');
        if (!found) throw new Error('Draft not kept on this phone');
        if (!live) return;
        setLocator(head);
        setDraftAt(head.currentDraftId);
        setDraft(found);
        setDraftError(null);
        setCachedError(null);
      } catch {
        if (live) setCachedError('Open this job once online to keep its field work on this phone.');
      }
    })();
    return () => { live = false; };
  }, [session.online, session.db, session.companyId, jobId, draft, denial]);

  // A photo that settled after an earlier screen of this job closed changed the draft: read it again.
  useEffect(() => {
    // Read after this render, as an answer to the change the store posted.
    if (draftChanges > 0) void Promise.resolve().then(() => reloadDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftChanges]);

  if (!detail && (denial || (error && (!locator || !draft)))) {
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
  if (!detail && (!locator || !draft)) {
    return <p role="status">{session.online ? 'Opening the job…' : cachedError ?? 'Opening saved field work…'}</p>;
  }
  const draftId = locator?.currentDraftId ?? detail!.job.currentDraftId;

  const context: JobContext = {
    session,
    detail,
    jobId,
    setDetail,
    reloadJob,
    draft,
    // Until a newer locator's draft finishes loading, the old form remains bound to its own
    // document and read-only. Typed values from it must never be written onto a different draft.
    draftRef: { companyId: session.companyId, draftId: draftAt ?? draftId },
    reloadDraft: (source) => reloadDraft(draftAt ?? draftId, source),
    checkAccess,
    editable: draftAt === draftId && draft !== null && canEditDraft(draft, session.user.uid, session.capabilities) && (session.online || session.offlineCapture),
    stale: draft !== null && draftError !== null,
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
      <h2 className="text-xl font-semibold break-words">{detail ? detail.job.propertyAddress || 'No address yet' : 'Saved field work'}</h2>
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
          <Button variant="outline" onClick={() => void openDraft()}>
            Try again
          </Button>
        </div>
      ) : null}
      {(view === 'scope' || view === 'photos') && !draft && !draftError && cachedError ? <p role="status">{cachedError}</p> : null}
      {/* The views of one job stay mounted and only the open one shows, so moving between them
          keeps what the person has typed and not saved. */}
      <div hidden={view !== 'scope'}>{draft ? <ScopeView key={draftAt} job={context} draft={draft} /> : null}</div>
      <div hidden={view !== 'photos'}>{draft ? <PhotosView key={draftAt} job={context} draft={draft} open={view === 'photos'} /> : null}</div>
      <div hidden={view !== 'customer'}>
        {detail ? (
          <CustomerView job={{ ...context, detail }} />
        ) : (
          <div className="flex flex-col gap-2">
            <p role="status">{error ?? 'Needs a connection'}</p>
            {error && session.online ? (
              <Button variant="outline" onClick={() => void reloadJob()}>
                Try again
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
