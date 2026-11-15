'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { claimFieldOwner, readJob, type JobDetail, type Refusal } from '@/lib/field/api';
import { newerDetail, pending, usePending } from '@/lib/field/pending';
import type { FieldSession } from '@/lib/field/session';
import { canEditDraft, fieldRefusal, InvalidFieldData, loadDraft, type DraftRef, type FieldDraft } from '@/lib/field/store';
import type { JobView } from '@/lib/field/views';
import { CoordinationView } from './coordination-view';
import { CustomerView } from './customer-view';
import { PhotosView } from './photos-view';
import { ScopeView } from './scope-view';
import { FieldLink, Outcome } from './ui';

const TABS: { view: JobView; label: string }[] = [
  { view: 'scope', label: 'Check Scope' },
  { view: 'customer', label: 'Customer and claim' },
  { view: 'photos', label: 'Photos' },
  { view: 'coordination', label: 'Job coordination' },
];

// Who owns this job's field work, as this person sees it (S5b-1): the rules let the owner and office
// read every draft, and anyone else only the drafts they own (web/firestore.rules), so an estimator
// whose job is owned by someone else, or by nobody yet, is not sent to read a draft they would be
// refused.
type FieldWork = 'mine' | 'other' | 'nobody';

function fieldWorkOf(session: FieldSession, detail: JobDetail): FieldWork {
  const owner = detail.job.fieldOwnerActorId;
  if (owner === null) return 'nobody';
  return owner === session.actorId ? 'mine' : 'other';
}

const readsEveryDraft = (session: FieldSession) => session.role === 'owner' || session.role === 'office';
const draftReadable = (session: FieldSession, detail: JobDetail) => readsEveryDraft(session) || fieldWorkOf(session, detail) === 'mine';

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
  // Takes a refusal of the photo route or the field database (null for none): 401 drops the job
  // from the screen; a 403 or 404 reads the job again, and that decides.
  checkAccess: (refusal: Refusal | null) => void;
  // The server no longer shows this job to this person, but the field work on screen was theirs:
  // it stays, read only, with what they changed and did not save (owner decision J5).
  gone: boolean;
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
  // The job names this person as its field owner but the draft does not yet (the server's draft step
  // did not get through): Start field work, sent again, sets it.
  const [ownerUnset, setOwnerUnset] = useState(false);

  // The server refused the job to this person: every copy of it goes (src/lib/field/pending.ts).
  const deny = useCallback(
    (message: string) => {
      pending.denyDetail(jobId, message);
      setDraft(null);
    },
    [jobId],
  );
  // A refusal to show the job after a read: the field work stays on screen only while the draft as
  // last read names this person as its field owner.
  const dropUnlessMine = useCallback(() => setDraft((current) => (current?.fieldOwnerUid === session.user.uid ? current : null)), [session.user.uid]);

  const reloadDraft = useCallback(
    async (current?: JobDetail) => {
      const job = current ?? detail;
      if (!job || !session.db) return;
      // Field work that is no longer this person's stays on screen as last read, read only, with
      // whatever they changed and did not save (owner decision J5; S6 offers Save as new draft).
      if (!draftReadable(session, job)) {
        setDraftError(null);
        setOwnerUnset(false);
        return;
      }
      try {
        const found = await loadDraft(session.db, { companyId: session.companyId, draftId: job.job.currentDraftId });
        setDraft(found);
        setOwnerUnset(false);
        setDraftError(found ? null : 'The field work of this job is not there yet. Try again in a moment.');
      } catch (error) {
        const refusal = fieldRefusal(error);
        if (refusal && refusal.status === 403 && !readsEveryDraft(session)) {
          setDraftError(null);
          setOwnerUnset(true);
          return;
        }
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
    [detail, session, deny],
  );

  const apply = useCallback(
    async (answer: Awaited<ReturnType<typeof readJob>>, sentAt: number): Promise<JobDetail | null> => {
      if (!pending.readAnswered(jobId, answer, sentAt)) return null;
      setError(answer.ok ? null : answer.message);
      if (!answer.ok) {
        // A refusal to show the job drops every copy of it; no answer keeps the one on screen.
        if (answer.denied) dropUnlessMine();
        return null;
      }
      setDetail(answer.value, sentAt);
      await reloadDraft(answer.value);
      return answer.value;
    },
    [reloadDraft, setDetail, jobId, dropUnlessMine],
  );

  const reloadJob = useCallback(async () => {
    const sentAt = pending.mark(jobId);
    return apply(await readJob(session.user, jobId), sentAt);
  }, [apply, session, jobId]);

  // A 403 may be the field work moving to another person: the job is read again, and only a refusal
  // to show it drops it; the draft and what was typed stay on screen, read only.
  const checkAccess = useCallback(
    (refusal: Refusal | null) => {
      if (!refusal) return;
      if (refusal.status === 401) return deny(refusal.message);
      if (refusal.status === 403) return void reloadJob();
      if (refusal.status !== 404) return;
      const sentAt = pending.mark(jobId);
      void readJob(session.user, jobId).then((answer) => {
        if (pending.readAnswered(jobId, answer, sentAt) && !answer.ok && answer.denied) dropUnlessMine();
      });
    },
    [deny, jobId, session.user, reloadJob, dropUnlessMine],
  );

  // The first read; each job is its own component (keyed by the parent).
  useEffect(() => {
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
  }, []);

  // A photo that settled after an earlier screen of this job closed changed the draft: read it again.
  useEffect(() => {
    // Read after this render, as an answer to the change the store posted.
    if (draftChanges > 0) void Promise.resolve().then(() => reloadDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftChanges]);

  // Refused to this person while their field work was on screen: the job as last read stays, read only.
  const kept = !detail && denial !== null && draft !== null && draft.fieldOwnerUid === session.user.uid ? (read?.detail ?? null) : null;
  if ((error || denial) && !detail && !kept) {
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
  const shown = detail ?? kept;
  if (!shown) return <p role="status">Opening the job…</p>;
  const gone = kept !== null;

  const fieldWork = fieldWorkOf(session, shown);
  const ownerOnJobOnly = !gone && fieldWork === 'mine' && (ownerUnset || (draft !== null && draft.fieldOwnerUid !== session.user.uid));
  const context: JobContext = {
    session,
    detail: shown,
    setDetail,
    reloadJob,
    draft,
    draftRef: { companyId: session.companyId, draftId: shown.job.currentDraftId },
    reloadDraft: () => reloadDraft(shown),
    checkAccess,
    gone,
    editable: !gone && draft !== null && fieldWork === 'mine' && !ownerUnset && canEditDraft(draft, session.user.uid, session.capabilities),
    stale: draft !== null && draftError !== null,
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
      <h2 className="text-xl font-semibold break-words">{shown.job.propertyAddress || 'No address yet'}</h2>
      <nav aria-label="Job" className="flex flex-wrap gap-x-4">
        {TABS.filter((tab) => tab.view !== 'coordination' || session.capabilities.some((key) => key === 'coordination' || key === 'assignment')).map((tab) => (
          <FieldLink key={tab.view} to={{ view: tab.view, jobId }} current={tab.view === view} className={tab.view === view ? 'font-semibold' : undefined}>
            {tab.label}
          </FieldLink>
        ))}
      </nav>
      {gone ? (
        <p role="alert" className="rounded-md bg-foreground/5 p-3 text-sm">
          {denial} What you changed and did not save stays on this phone, read only, and is not saved to this job.
        </p>
      ) : null}
      {(view === 'scope' || view === 'photos') &&
      session.capabilities.includes('scope') &&
      ((!gone && fieldWork === 'nobody' && shown.job.status === 'draft') || ownerOnJobOnly) ? (
        <StartFieldWork context={context} resume={ownerOnJobOnly} />
      ) : null}
      {(view === 'scope' || view === 'photos') && !gone && fieldWork === 'other' && !readsEveryDraft(session) ? (
        <p className="rounded-md bg-foreground/5 p-3 text-sm">
          {draft === null
            ? 'Another person owns this job’s field work, so it is not shown here. The company owner can move it to you.'
            : 'Another person now owns this job’s field work, so this phone shows it read only. What you changed and did not save stays here, and is not saved to this job.'}
        </p>
      ) : null}
      {(view === 'scope' || view === 'photos') && !gone && draft !== null && !context.editable && !(fieldWork === 'other' && !readsEveryDraft(session)) ? (
        <p className="rounded-md bg-foreground/5 p-3 text-sm">
          Read only. Only the person who owns this job&rsquo;s field work changes it, while the job is being edited.
        </p>
      ) : null}
      {(view === 'scope' || view === 'photos') && !session.db ? (
        <p role="alert">The field database is not set up for this company yet.</p>
      ) : null}
      {(view === 'scope' || view === 'photos') && draftError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{draftError}</p>
          <Button variant="outline" onClick={() => void reloadDraft(shown)}>
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
      <div hidden={view !== 'coordination'}>
        <CoordinationView job={context} open={view === 'coordination'} />
      </div>
    </div>
  );
}

// "First capture makes me field owner" (S5b-1, docs/spec.md 6.2): on a job nobody owns in the field
// yet, the first person who does field work starts it and owns it from then on; the server sets the
// draft's field owner, and the draft is read again. Sent again after no answer, it is the same
// request: the server answers the same person with the same job.
function StartFieldWork({ context, resume }: { context: JobContext; resume: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const answer = await claimFieldOwner(context.session.user, context.detail.job.id);
    setBusy(false);
    // The job and its draft are read again: the draft now names this person as its field owner.
    if (answer.ok) {
      await context.reloadJob();
      return;
    }
    setError(answer.message);
    // Someone else started it meanwhile, or the job moved on: read it again.
    if (answer.status === 409 || answer.status === 404) await context.reloadJob();
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-foreground/5 p-3">
      <p className="text-sm">
        {resume
          ? 'This job’s field work is yours, but this phone cannot open it yet. Start field work again to finish.'
          : 'Nobody has started this job’s field work yet. Whoever starts it owns it: only they can change it from then on.'}
      </p>
      <Button onClick={() => void start()} disabled={busy}>
        {busy ? 'Starting…' : 'Start field work'}
      </Button>
      <Outcome error={error} notice={null} />
    </div>
  );
}
