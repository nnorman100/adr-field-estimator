'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readJob, type JobDetail, type Refusal } from '@/lib/field/api';
import { loadJobProjection, type JobProjection } from '@/lib/field/job-projection';
import { newerDetail, pending, usePending } from '@/lib/field/pending';
import type { FieldSession } from '@/lib/field/session';
import { canEditDraft, draftReads, fieldRefusal, IncompleteFieldData, InvalidFieldData, SUPERSEDED, type DraftRef, type FieldDraft } from '@/lib/field/store';
import type { JobView } from '@/lib/field/views';
import { CustomerView } from './customer-view';
import { PhotosView } from './photos-view';
import { ScopeView } from './scope-view';
import { CoordinationView } from './coordination-view';
import { ArchivedNotice, JobActions } from './job-actions';
import { StartFieldWork } from './start-field-work';
import { FieldLink } from './ui';

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

// Owner decision J5: the field work moved to another person (or this person was unassigned with it).
// What they typed and did not send stays on this phone, read only; Save as new draft is S6.
const MOVED_TEXT =
  'This job’s field work is no longer yours: another person owns it now. What you changed and did not save stays on this phone, read only, and is not saved to this job.';
const OTHER_OWNS_TEXT = 'Another person owns this job’s field work, so it is not shown here. The company owner can move it to you.';

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
  // job from the screen; a 404 may be a missing photo, and a 410 an archive (S5b-2) made elsewhere,
  // so the job is read again and that decides.
  checkAccess: (refusal: Refusal | null) => void;
  // Takes the server's refusal of the job to this person (null for none). While their field work is
  // on this phone it stays, read only (owner decision J5); otherwise the job goes from the screen.
  refuse: (refusal: Refusal) => void;
  // The field work moved away from this person: everything of theirs on screen is read only.
  moved: boolean;
  // Whether this person may change the field work now (the rules' own test).
  editable: boolean;
  // The job is archived (S5b-2): nothing of it is sent, and what is on screen stays, read only.
  archived: boolean;
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
      if (!pending.publishDetail(jobId, next, sentAt)) return;
      // The job now names someone else while this person held its field work: recorded now, before any
      // newer draft replaces the one on screen, so it holds whoever that draft names (J5).
      if (pending.held(jobId) && next.job.fieldOwnerActorId !== null && next.job.fieldOwnerActorId !== session.actorId) pending.moveAway(jobId);
      setRead({ detail: next, mark: sentAt });
    },
    [jobId, session.actorId],
  );
  const draftChanges = usePending(() => pending.draftChanges(jobId));
  const [locator, setLocator] = useState<JobProjection | null>(null);
  const [cachedError, setCachedError] = useState<string | null>(null);
  // A job whose field work moved away from this person, opened again on this page, starts from the
  // draft as last read (src/lib/field/pending.ts).
  const movedState = usePending(() => pending.moved(jobId));
  const [draft, setDraft] = useState<FieldDraft | null>(() => pending.moved(jobId)?.draft ?? null);
  const [draftAt, setDraftAt] = useState<string | null>(() => pending.moved(jobId)?.draftId ?? null);
  // The job names this person as its field owner but the draft does not yet (the server's draft step
  // did not get through): Start field work, sent again, sets it.
  const [ownerUnset, setOwnerUnset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The job is archived (S5b-2), as the newest answer about it said: a read of it (410, or the job),
  // or an archive or restore done on this page (src/lib/field/pending.ts).
  const archived = usePending(() => pending.archived(jobId));
  const archivalsDone = usePending(() => pending.archivalsDone(jobId));
  const [archivalsSeen] = useState(archivalsDone);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [readDraft] = useState(draftReads);

  // The server refused the job to this person: every copy of it goes, unless their field work is on
  // this phone (owner decision J5, src/lib/field/pending.ts), when it stays, read only.
  const refuse = useCallback(
    (refusal: Refusal) => {
      if (!pending.refused(jobId, refusal.message, refusal.status)) setDraft(null);
    },
    [jobId],
  );
  // The field database refused the draft. An estimator whose job names them but whose draft does not
  // yet is sent to start the field work again; anything else is a refusal of the job.
  const refuseDraft = useCallback(
    (refusal: Refusal, job: JobDetail | null) => {
      if (refusal.status === 403 && draft === null && job && !readsEveryDraft(session) && fieldWorkOf(session, job) === 'mine' && !pending.moved(jobId)) {
        setDraftError(null);
        return setOwnerUnset(true);
      }
      refuse(refusal);
    },
    [draft, session, jobId, refuse],
  );
  // Whether the screens may read this job's draft: not the rules' refusal for an estimator whose job
  // is someone else's, and nothing more once the field work moved away.
  const mayReadDraft = useCallback(
    (job: JobDetail | null) => !pending.moved(jobId)?.revoked && (job === null || draftReadable(session, job)),
    [jobId, session],
  );

  const reloadDraft = useCallback(
    async (currentDraftId?: string, source?: 'cache', job?: JobDetail) => {
      const draftId = currentDraftId ?? locator?.currentDraftId ?? detail?.job.currentDraftId;
      if (!draftId || !session.db || !mayReadDraft(job ?? detail)) return;
      try {
        const found = await readDraft(session.db, { companyId: session.companyId, draftId }, source);
        if (found === SUPERSEDED) return;
        setDraftAt(draftId);
        setDraft(found);
        // The job names this person but the draft read (an owner reads every draft) names someone else:
        // the server's draft step did not get through, and Start field work finishes it.
        const named = job ?? detail;
        setOwnerUnset(found !== null && named !== null && fieldWorkOf(session, named) === 'mine' && found.fieldOwnerUid !== session.user.uid);
        setDraftError(found ? null : 'The field work of this job is not there yet. Try again in a moment.');
      } catch (error) {
        const refusal = fieldRefusal(error);
        if (refusal) return refuseDraft(refusal, job ?? detail);
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
    [detail, locator, session, refuseDraft, readDraft, mayReadDraft],
  );

  // The locator first, then the draft it names; trying again repeats both. `job` is the job just read,
  // which the state of this render does not hold yet.
  const openDraft = useCallback(
    async (job?: JobDetail) => {
      if (!mayReadDraft(job ?? detail)) {
        setDraftError(null);
        return;
      }
      try {
        // The API populated this server-owned locator, including for jobs made before S6. Read
        // the document itself to warm the person cache; never cache the API response.
        const head = await loadJobProjection(session.db, session.companyId, jobId);
        if (!head) throw new Error('Job locator unavailable');
        setLocator(head);
        setCachedError(null);
        await reloadDraft(head.currentDraftId, undefined, job ?? detail ?? undefined);
      } catch (error) {
        const refusal = fieldRefusal(error);
        if (refusal) refuseDraft(refusal, job ?? detail);
        else setDraftError('The field work could not be opened. Try again when connected.');
      }
    },
    [reloadDraft, jobId, session, refuseDraft, mayReadDraft, detail],
  );

  const apply = useCallback(
    async (answer: Awaited<ReturnType<typeof readJob>>, sentAt: number): Promise<JobDetail | null> => {
      if (!pending.readAnswered(jobId, answer, sentAt)) return null;
      setError(answer.ok ? null : answer.message);
      if (!answer.ok) {
        // A refusal to show the job drops every copy of it (unless the field work is this person's on
        // this phone, J5); no answer keeps the one on screen.
        if (answer.denied && pending.denial(jobId)) setDraft(null);
        return null;
      }
      // The job is this person's field work again: it opens as usual.
      if (answer.value.job.fieldOwnerActorId === session.actorId) pending.returned(jobId);
      setDetail(answer.value, sentAt);
      await openDraft(answer.value);
      return answer.value;
    },
    [openDraft, setDetail, jobId, session.actorId],
  );

  const reloadJob = useCallback(async () => {
    // Server access of a moved job stays revoked: nothing more is asked of it.
    if (!session.online || pending.moved(jobId)?.revoked) return null;
    const sentAt = pending.mark(jobId);
    return apply(await readJob(session.user, jobId), sentAt);
  }, [apply, session, jobId]);

  const checkAccess = useCallback(
    (refusal: Refusal | null) => {
      if (!refusal) return;
      if (refusal.status === 401 || refusal.status === 403) return refuse(refusal);
      if (refusal.status !== 404 && refusal.status !== 410) return;
      const sentAt = pending.mark(jobId);
      void readJob(session.user, jobId).then((answer) => {
        if (pending.readAnswered(jobId, answer, sentAt) && !answer.ok && answer.denied && pending.denial(jobId)) setDraft(null);
      });
    },
    [refuse, jobId, session.user],
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
        const found = await readDraft(session.db, { companyId: session.companyId, draftId: head.currentDraftId }, 'cache');
        if (found === SUPERSEDED) return;
        if (!found) throw new Error('Draft not kept on this phone');
        if (!live) return;
        setLocator(head);
        setDraftAt(head.currentDraftId);
        setDraft(found);
        setDraftError(null);
        setCachedError(null);
      } catch (error) {
        if (!live) return;
        setCachedError(
          error instanceof IncompleteFieldData
            ? 'Only part of this job’s field work is kept on this phone. Open it once online to keep all of it.'
            : 'Open this job once online to keep its field work on this phone.',
        );
      }
    })();
    return () => { live = false; };
  }, [session.online, session.db, session.companyId, jobId, draft, denial, readDraft]);

  // An archive or restore of this job was done on this page, from this screen or any other: read it again.
  useEffect(() => {
    if (archivalsDone !== archivalsSeen) void Promise.resolve().then(() => reloadJob());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archivalsDone]);

  // A photo that settled after an earlier screen of this job closed changed the draft: read it again.
  useEffect(() => {
    // Read after this render, as an answer to the change the store posted.
    if (draftChanges > 0) void Promise.resolve().then(() => reloadDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftChanges]);

  // Whether this person's field work of the job is on this phone: the job names them, or the draft as
  // read does. A refusal then keeps the work on screen instead of dropping the job (J5).
  const held = (detail !== null && detail.job.fieldOwnerActorId === session.actorId) || draft?.fieldOwnerUid === session.user.uid;
  useEffect(() => pending.hold(jobId, held), [jobId, held]);
  // The draft as last read goes with a moved job, for a screen of it opened again on this page.
  const draftId = locator?.currentDraftId ?? detail?.job.currentDraftId ?? null;
  useEffect(() => {
    if (movedState && draft && (draftAt ?? draftId)) pending.keepDraft(jobId, draft, (draftAt ?? draftId)!);
  }, [movedState, draft, draftAt, draftId, jobId]);

  // An archived job (an old link, or archived here) shows that it is archived: every job route answers
  // it 410, and the field rules refuse every write to its draft. Screens of the job as read here stay,
  // read only, with whatever the person changed and did not save.
  if (archived && !detail) {
    return (
      <div className="flex flex-col gap-3">
        <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
        <ArchivedNotice session={session} jobId={jobId} />
      </div>
    );
  }
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
  const currentDraftId = locator?.currentDraftId ?? detail!.job.currentDraftId;
  const fieldWork = detail ? fieldWorkOf(session, detail) : null;
  const reader = readsEveryDraft(session);
  // The field work moved away from this person (J5): the server refused them, or the job named someone
  // else while they held it; recorded in src/lib/field/pending.ts, whoever the draft now names.
  const moved = movedState !== null;
  const startable =
    session.capabilities.includes('scope') &&
    !moved &&
    !archived &&
    detail !== null &&
    ((fieldWork === 'nobody' && detail.job.status === 'draft') || (ownerUnset && fieldWork === 'mine'));

  const context: JobContext = {
    session,
    detail,
    jobId,
    setDetail,
    reloadJob,
    draft,
    // Until a newer locator's draft finishes loading, the old form remains bound to its own
    // document and read-only. Typed values from it must never be written onto a different draft.
    draftRef: { companyId: session.companyId, draftId: draftAt ?? currentDraftId },
    reloadDraft: (source) => reloadDraft(draftAt ?? currentDraftId, source),
    checkAccess,
    refuse,
    moved,
    editable:
      !moved && !archived && !ownerUnset && draftAt === currentDraftId && draft !== null && canEditDraft(draft, session.user.uid, session.capabilities) && (session.online || session.offlineCapture),
    archived,
    stale: draft !== null && draftError !== null,
  };
  const onDraftViews = view === 'scope' || view === 'photos';

  return (
    <div className="flex flex-col gap-4">
      <FieldLink to={{ view: 'jobs', list: null }}>Back to jobs</FieldLink>
      <h2 className="text-xl font-semibold break-words">{detail ? detail.job.propertyAddress || 'No address yet' : 'Saved field work'}</h2>
      <nav aria-label="Job" className="flex flex-wrap gap-x-4">
        {TABS.filter((tab) => tab.view !== 'coordination' || session.capabilities.some((key) => key === 'coordination' || key === 'assignment')).map((tab) => (
          <FieldLink key={tab.view} to={{ view: tab.view, jobId }} current={tab.view === view} className={tab.view === view ? 'font-semibold' : undefined}>
            {tab.label}
          </FieldLink>
        ))}
      </nav>
      {archived ? <ArchivedNotice session={session} jobId={jobId} /> : null}
      {moved ? (
        <p role="alert" className="rounded-md bg-foreground/5 p-3 text-sm">
          {MOVED_TEXT}
        </p>
      ) : null}
      {onDraftViews && startable && detail ? <StartFieldWork context={{ ...context, detail }} resume={ownerUnset && fieldWork === 'mine'} /> : null}
      {onDraftViews && !moved && !reader && fieldWork === 'other' ? <p className="rounded-md bg-foreground/5 p-3 text-sm">{OTHER_OWNS_TEXT}</p> : null}
      {onDraftViews && draft !== null && !moved && !archived && !context.editable && !(fieldWork === 'other' && !reader) ? (
        <p className="rounded-md bg-foreground/5 p-3 text-sm">
          Read only. Only the estimator who owns this job&rsquo;s field work changes it, while the job is being edited.
        </p>
      ) : null}
      {onDraftViews && !session.db ? <p role="alert">The field database is not set up for this company yet.</p> : null}
      {onDraftViews && draftError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{draftError}</p>
          <Button variant="outline" onClick={() => void openDraft()}>
            Try again
          </Button>
        </div>
      ) : null}
      {onDraftViews && !draft && !draftError && cachedError ? <p role="status">{cachedError}</p> : null}
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
      <div hidden={view !== 'coordination'}>{detail ? <CoordinationView job={{ ...context, detail }} open={view === 'coordination'} /> : null}</div>
      {/* Archive and Copy follow the person's keys and the job's state; the moved, read-only state
          limits only field editing. */}
      {detail && !archived ? <JobActions job={{ ...context, detail }} /> : null}
    </div>
  );
}
