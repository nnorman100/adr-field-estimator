'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readJob, type JobDetail, type Refusal } from '@/lib/field/api';
import { loadJobProjection, type JobProjection } from '@/lib/field/job-projection';
import { watchJournal } from '@/lib/field/journal';
import { journalFailed, readEntries } from '@/lib/field/journal-sync';
import { newerDetail, pending, usePending } from '@/lib/field/pending';
import type { FieldSession } from '@/lib/field/session';
import { canEditDraft, draftPath, draftReads, fieldRefusal, IncompleteFieldData, InvalidFieldData, SUPERSEDED, type DraftRef, type FieldDraft } from '@/lib/field/store';
import type { JobView } from '@/lib/field/views';
import { useDraftReadiness } from '@/lib/readiness/client';
import { fixTarget } from '@/lib/readiness/fix';
import type { ReadinessAnswer } from '@/lib/readiness/schema';
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

// Where a Fix lands when its own control is not there or not usable, as for a read-only draft.
const FIX_FALLBACKS: Record<string, string> = { 'new-room-name': 'readiness-rooms', 'photo-room': 'readiness-photos' };
const JOURNAL_READ_MS = 8_000;

const readsEveryDraft = (session: FieldSession) => session.role === 'owner' || session.role === 'office';
const draftReadable = (session: FieldSession, detail: JobDetail) => readsEveryDraft(session) || fieldWorkOf(session, detail) === 'mine';

// Owner decision J5: the field work moved to another person (or this person was unassigned with it).
// What they typed and did not send stays on this phone, read only; Save as new draft is S6.
const MOVED_TEXT =
  'This job’s field work is no longer yours: another person owns it now. What you changed and did not save stays on this phone, read only, and is not saved to this job.';
const OTHER_OWNS_TEXT = 'Another person owns this job’s field work, so it is not shown here. The company owner can move it to you.';


// How many times a job whose field work is being got ready is read again before the screen says so.
const PREPARE_TRIES = 5;
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
  // Takes a refusal of the photo route or the field database (null for none): 401, or 403 while this
  // person's field work is not on this phone, drops the job from the screen; a 403 while it is may be
  // a move (J5) or an archive made elsewhere, a 404 a missing photo, and a 410 an archive (S5b-2), so
  // the job is read again, nothing is saved until a read answers, and the read decides.
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
  // Nothing of the job is sent: it is archived, or a read of it must say first whether an archive or
  // another refusal changed it. What was typed stays, read only.
  held: boolean;
  // Each mounted form registers how to clear its unsent values on discard, and whether it holds any now.
  markUnsaved: (form: string, discard: (() => void) | null, unsaved?: boolean) => void;
  // Keeps the return guard active during local preparation, before a write can be tracked elsewhere.
  startSave: () => (failed?: boolean) => void;
  // The last read of the draft did not get through, so the draft on screen may be older than what is
  // stored: boxes stay open, but nothing is saved over it until it is read again.
  stale: boolean;
  // The advisory readiness answer for this draft: `checking` while this screen asks for it, `answer`
  // undefined until it is back and null when it is unusable; `recheck` asks again after an accepted save.
  readiness: { checking: boolean; answer: Extract<ReadinessAnswer, { status: 'checked' }> | null | undefined; recheck: () => void };
};


// One job's screens (S5a-6): the job from the jobs API (header, customer, claim) and its field
// draft from the field database, read once and again after each save, so what is on screen is what
// is stored. Office, the owner who is not the field owner, and anyone once the draft is no longer
// being edited see the field work read-only, as the rules hold it.
export function JobScreens({
  session, jobId, view, readinessFix, address,
}: { session: FieldSession; jobId: string; view: JobView; readinessFix: string | null; address: string }) {
  const focusedFix = useRef<string | null>(null);
  const [read, setRead] = useState<{ detail: JobDetail; mark: number } | null>(null);
  // A save that settled after an earlier screen of this job closed posts the job it got back
  // (src/lib/field/pending.ts); the newer of that and this screen's own read is the job shown. Once
  // the server refuses the job to this person, in this screen or another, neither is shown.
  const posted = usePending(() => pending.detail(jobId));
  const mark = usePending(() => pending.mark(jobId));
  const denial = usePending(() => pending.denial(jobId));
  // A refused job list (a suspended company, a removed member) takes every cached copy of a job, with
  // its address and customer, off screen until a list is answered again (src/lib/field/pending.ts).
  const listDenied = usePending(() => pending.listDenied());
  const detail = listDenied ? null : newerDetail(read !== null && read.mark >= mark ? read.detail : null, posted);
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
  // The job names this person as its field owner but the draft is not there or does not name them yet (a
  // field step that did not get through): the job read prepares it (the draft life-cycle redesign, slice 6),
  // so the screen reads the job again, a few times, each answer still checked against the newest read.
  const [gettingReady, setGettingReady] = useState(false);
  const [prepareTries, setPrepareTries] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The job is archived (S5b-2), as the newest answer about it said: a read of it (410, or the job),
  // or an archive or restore done on this page (src/lib/field/pending.ts).
  const archivedSaid = usePending(() => pending.archived(jobId));
  const archivalsDone = usePending(() => pending.archivalsDone(jobId));
  const [archivalsSeen] = useState(archivalsDone);
  const [draftError, setDraftError] = useState<string | null>(null);
  // The forms of this job on this screen that hold changes not saved (told by each form).
  const unsavedForms = useRef(new Map<string, { discard: () => void; unsaved: boolean }>());
  const [hasUnsavedForms, setHasUnsavedForms] = useState(false);
  const markUnsaved = useCallback((form: string, discard: (() => void) | null, unsaved = true) => {
    if (discard) unsavedForms.current.set(form, { discard, unsaved });
    else unsavedForms.current.delete(form);
    setHasUnsavedForms([...unsavedForms.current.values()].some((one) => one.unsaved));
  }, []);
  const typed = usePending(() => pending.typed(jobId));
  const unsaved = hasUnsavedForms || Object.keys(typed).length > 0;
  const hasUnsent = useCallback(
    () => [...unsavedForms.current.values()].some((form) => form.unsaved) || Object.keys(pending.typed(jobId)).length > 0,
    [jobId],
  );
  const [readDraft] = useState(draftReads);
  // A refusal waits for a read of the job to say what it meant (src/lib/field/pending.ts): nothing
  // is saved meanwhile.
  const verifying = usePending(() => pending.verifying(jobId));
  // An archive with no sure answer is being checked: nothing of the job is sent from any section.
  const archiveChecking = usePending(() => pending.archiveChecking(jobId));

  // The server refused the job to this person: every copy of it goes, unless their field work is on
  // this phone (owner decision J5, src/lib/field/pending.ts), when it stays, read only.
  const refuse = useCallback(
    (refusal: Refusal) => {
      if (!pending.refused(jobId, refusal.message, refusal.status)) setDraft(null);
    },
    [jobId],
  );
  // The field database refused the draft. A field owner whose job names them (an estimator or the company
  // owner, with a draft already on screen or not) gets it got ready by the job read; anything else is a
  // refusal of the job.
  const refuseDraft = useCallback(
    (refusal: Refusal, job: JobDetail | null) => {
      if (refusal.status === 403 && job && fieldWorkOf(session, job) === 'mine' && !pending.moved(jobId)) {
        setDraftError(null);
        return setGettingReady(true);
      }
      refuse(refusal);
    },
    [session, jobId, refuse],
  );
  // Whether the screens may read this job's draft: not the rules' refusal for an estimator whose job
  // is someone else's, and nothing more once the field work moved away.
  const mayReadDraft = useCallback(
    (job: JobDetail | null) => !pending.moved(jobId)?.revoked && (job === null || draftReadable(session, job)),
    [jobId, session],
  );

  // `mark`: the job read that started this draft read, whose answers count only while it is the newest.
  const reloadDraft = useCallback(
    async (currentDraftId?: string, source?: 'cache', job?: JobDetail, mark?: number) => {
      const draftId = currentDraftId ?? locator?.currentDraftId ?? detail?.job.currentDraftId;
      if (!draftId || !session.db || !mayReadDraft(job ?? detail)) return;
      const current = () => mark === undefined || pending.newestRead(jobId, mark);
      try {
        const found = await readDraft(session.db, { companyId: session.companyId, draftId }, source);
        if (found === SUPERSEDED || !current()) return;
        // The job names this person but the draft is not there, or the draft read (an owner reads every
        // draft) names someone else or is a placeholder: a field step did not get through, and the job read
        // prepares it.
        const named = job ?? detail;
        const mine = named !== null && fieldWorkOf(session, named) === 'mine';
        const unready = mine && (found === null || found.fieldOwnerUid !== session.user.uid);
        // A draft not there yet never takes the one on screen away, with what the person typed in it.
        if (!(unready && found === null)) {
          setDraftAt(draftId);
          setDraft(found);
        }
        setGettingReady(unready);
        if (!unready) setPrepareTries(0);
        setDraftError(found || unready ? null : 'The field work of this job is not there yet. Try again in a moment.');
      } catch (error) {
        if (!current()) return;
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
    [detail, locator, session, refuseDraft, readDraft, mayReadDraft, jobId],
  );

  // The locator first, then the draft it names; trying again repeats both. `job` is the job just read,
  // which the state of this render does not hold yet.
  const openDraft = useCallback(
    async (job?: JobDetail, mark?: number) => {
      if (!mayReadDraft(job ?? detail)) {
        setDraftError(null);
        return;
      }
      // What a read started counts only while it is the newest read of the job (src/lib/field/pending.ts).
      const current = () => mark === undefined || pending.newestRead(jobId, mark);
      try {
        // The API populated this server-owned locator, including for jobs made before S6. Read
        // the document itself to warm the person cache; never cache the API response.
        const head = await loadJobProjection(session.db, session.companyId, jobId);
        if (!current()) return;
        if (!head) throw new Error('Job locator unavailable');
        setLocator(head);
        setCachedError(null);
        await reloadDraft(head.currentDraftId, undefined, job ?? detail ?? undefined, mark);
      } catch (error) {
        if (!current()) return;
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
        // this phone, J5); no answer keeps the one on screen. A refusal or an archive ends getting the
        // field work ready: there is nothing more to read.
        if (answer.denied || answer.status === 410) setGettingReady(false);
        if (answer.denied && pending.denial(jobId)) setDraft(null);
        return null;
      }
      // The job is this person's field work again: it opens as usual.
      if (answer.value.job.fieldOwnerActorId === session.actorId) pending.returned(jobId);
      setDetail(answer.value, sentAt);
      await openDraft(answer.value, sentAt);
      return answer.value;
    },
    [openDraft, setDetail, jobId, session.actorId],
  );

  const reloadJob = useCallback(async () => {
    // Server access of a moved job stays revoked: nothing more is asked of it.
    if (!session.online || pending.moved(jobId)?.revoked) return null;
    const sentAt = pending.markRead();
    return apply(await readJob(session.user, jobId), sentAt);
  }, [apply, session, jobId]);

  // While the field work is being got ready, the job is read again (the read prepares it), sooner then
  // later: 1, 2, 4, 8 and 8 seconds after the previous try settled (its job read and the draft read it
  // started), one at a time. Each answer is applied only if it is the newest read's (apply).
  const tryInFlight = useRef(false);
  useEffect(() => {
    if (!gettingReady || !session.online || prepareTries >= PREPARE_TRIES || tryInFlight.current) return;
    const timer = setTimeout(() => {
      tryInFlight.current = true;
      void reloadJob().finally(() => {
        tryInFlight.current = false;
        setPrepareTries((tries) => tries + 1);
      });
    }, Math.min(1000 * 2 ** prepareTries, 8000));
    return () => clearTimeout(timer);
  }, [gettingReady, prepareTries, session.online, reloadJob]);

  const checkAccess = useCallback(
    (refusal: Refusal | null) => {
      if (!refusal) return;
      if (refusal.status === 401 || (refusal.status === 403 && !pending.held(jobId))) return refuse(refusal);
      if (refusal.status !== 403 && refusal.status !== 404 && refusal.status !== 410) return;
      if (refusal.status === 410) pending.archivedSeen(jobId);
      pending.verify(jobId);
    },
    [refuse, jobId],
  );

  // The first read; each job is its own component (keyed by the parent).
  useEffect(() => {
    if (!session.online) return;
    let live = true;
    const sentAt = pending.markRead();
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

  // A refusal waits for a read of the job: read it again.
  useEffect(() => {
    if (verifying !== null) void Promise.resolve().then(() => reloadJob());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifying]);

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
  // Archived as the newest answer about the job said, or as its field draft on screen says.
  // A draft read as archived says the job is archived, except while the field work is being got ready (an
  // archived placeholder a previous version left over a restored job's missing draft says nothing).
  const archived = archivedSaid || (draft?.state === 'archived' && !gettingReady);
  const [rechecks, setRechecks] = useState(0);
  const recheck = useCallback(() => setRechecks((count) => count + 1), []);
  const currentRefId = draftAt ?? locator?.currentDraftId ?? detail?.job.currentDraftId;
  const row = detail?.job;
  const checking =
    (view === 'scope' || view === 'photos') && session.online && session.readiness && session.capabilities.includes('scope') &&
    !archived && !archiveChecking && movedState === null && draft !== null && draftError === null && draft.state === 'editing' &&
    row?.status === 'draft' && row.currentDraftId === currentRefId;
  const manifest = useMemo(() => (draft ? { draft: draft.field, rooms: draft.rooms, photos: draft.photos } : null), [draft]);
  const archiveSeen = useCallback(() => checkAccess({ status: 410, message: 'This job is archived.' }), [checkAccess]);
  const advisory = useDraftReadiness(session.user, checking ? row! : null, manifest, rechecks, archiveSeen);
  // The draft as last read goes with a moved job, for a screen of it opened again on this page.
  const draftId = locator?.currentDraftId ?? detail?.job.currentDraftId ?? null;
  useEffect(() => {
    if (movedState && draft && (draftAt ?? draftId)) pending.keepDraft(jobId, draft, (draftAt ?? draftId)!);
  }, [movedState, draft, draftAt, draftId, jobId]);

  const returnAllowed = session.capabilities.includes('scope') && detail?.job.status === 'draft' && !archived && !movedState && !archiveChecking;
  const target = fixTarget(readinessFix, view);
  const fix = session.readiness && returnAllowed ? target : null;
  // Once a Fix brought the person here, the way back to Finish stays for this job's other tabs too.
  const [fromFinish, setFromFinish] = useState(false);
  if (fix && !fromFinish) setFromFinish(true);
  const finishHref = `/sign-in/${address}/jobs/${jobId}/finish`;
  const returnGuarded = fromFinish && returnAllowed;
  // Back to Finish asks to save or discard while any form holds unsaved input, then waits until this
  // job's field writes and photo sends have the server's acknowledgement: Finish reads the manifest
  // from the field database, not from this phone.
  const [leaving, setLeaving] = useState<'no' | 'choosing' | 'going' | 'blocked'>('no');
  if (leaving === 'choosing' && !unsaved) setLeaving('no');
  const [preparing, setPreparing] = useState(0);
  const startSave = useCallback(() => {
    setPreparing((count) => count + 1);
    return (failed = false) => {
      setPreparing((count) => count - 1);
      if (failed) setLeaving((current) => current === 'going' ? 'blocked' : current);
    };
  }, []);
  const record = usePending(() => pending.record(jobId));
  const coordination = usePending(() => pending.coordWrite(jobId));
  const photos = usePending(() => pending.photos(jobId));
  const [journal, setJournal] = useState<'reading' | 'pending' | 'clear' | 'failed'>('reading');
  const fieldClient = session.client;
  const currentPath = row ? draftPath({ companyId: session.companyId, draftId: row.currentDraftId }) : null;
  const going = leaving === 'going';
  useEffect(() => {
    if (!returnGuarded) return;
    let live = true;
    let reads = 0;
    const load = async () => {
      const mine = ++reads;
      if (!live) return;
      setJournal('reading');
      try {
        const entries = (await readEntries(fieldClient)).filter((entry) =>
          entry.jobId === jobId || (!entry.jobId && entry.draftPath === currentPath),
        );
        if (live && mine === reads) {
          setJournal(entries.some((entry) => entry.state !== 'pending') ? 'failed' : entries.length ? 'pending' : 'clear');
        }
      } catch (error) {
        if (!live || mine !== reads) return;
        setJournal('failed');
        journalFailed(fieldClient, error);
      }
    };
    void Promise.resolve().then(load);
    const stop = watchJournal({ tenantId: fieldClient.person.tenantId, uid: fieldClient.person.uid }, () => void load());
    return () => {
      live = false;
      stop();
    };
  }, [returnGuarded, going, fieldClient, jobId, currentPath]);
  const failed = journal === 'failed' || record?.sending === false || coordination?.sending === false || photos.some((photo) => photo.step === 'send-failed' || photo.step === 'save-failed');
  const writing = journal !== 'clear' || preparing > 0 || record !== null || coordination !== null || photos.length > 0;
  if (returnGuarded && going && failed) setLeaving('blocked');
  const returnToFinish = () => {
    setJournal('reading');
    setLeaving('going');
  };
  useLayoutEffect(() => {
    if (!returnGuarded || !(unsaved || writing)) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!writing && !hasUnsent()) return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [returnGuarded, unsaved, writing, hasUnsent]);
  useEffect(() => {
    // The deadline belongs to confirming the journal. A live upload, save or office write in this page
    // keeps the return waiting for its acknowledgement; an entry nothing here is sending (an older app's)
    // or a read that does not finish is reported instead of showing "Saving…" forever.
    const live = preparing > 0 || record !== null || coordination !== null || photos.length > 0;
    if (!returnGuarded || !going || journal === 'clear' || live) return;
    const deadline = setTimeout(() => setLeaving('blocked'), JOURNAL_READ_MS);
    return () => clearTimeout(deadline);
  }, [returnGuarded, going, journal, preparing, record, coordination, photos.length]);
  useEffect(() => {
    if (!returnGuarded || !going || writing) return;
    const ready = setTimeout(() => {
      if (hasUnsent()) return setLeaving('choosing');
      // Finish opens a separate Firestore client and reads the current draft and flag.
      setLeaving('no');
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Release the field client's connections.
      window.location.assign(finishHref);
    }, 0);
    return () => clearTimeout(ready);
  }, [returnGuarded, going, writing, finishHref, hasUnsent]);
  useEffect(() => {
    if (!returnGuarded) return;
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving('no');
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, [returnGuarded]);
  useEffect(() => {
    if (!readinessFix) {
      focusedFix.current = null;
      return;
    }
    if (!fix) return;
    if (focusedFix.current === readinessFix) return;
    const usable = (found: HTMLElement) =>
      !found.closest('[hidden]') && !found.matches(':disabled') && !((found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement) && found.readOnly);
    const fallbackId = FIX_FALLBACKS[fix] ?? (view === 'scope' ? 'readiness-scope' : null);
    const element = [fix, fallbackId].map((id) => (id ? document.getElementById(id) : null)).find(
      (found): found is HTMLElement => found instanceof HTMLElement && usable(found),
    );
    if (!element) return;
    element.focus();
    if (document.activeElement === element) focusedFix.current = readinessFix;
  }, [readinessFix, fix, draft, view]);

  // An archived job (an old link, or archived here) shows that it is archived: every job route answers
  // it 410, and the field rules refuse every write to its draft. Screens of the job as read here stay,
  // read only, with whatever the person changed and did not save. A job opened from this phone's saved
  // field work (no job read yet) whose forms hold changes not saved keeps them mounted, read only, so
  // they are not lost; a job with none is the notice alone.
  if (archived && !detail && !(draft && unsaved)) {
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
    !archiveChecking &&
    detail !== null &&
    fieldWork === 'nobody' &&
    detail.job.status === 'draft';

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
      !moved && !archived && verifying === null && !gettingReady && draftAt === currentDraftId && draft !== null && canEditDraft(draft, session.user.uid, session.capabilities) && (session.online || session.offlineCapture),
    archived,
    held: archived || archiveChecking,
    markUnsaved,
    startSave,
    stale: draft !== null && draftError !== null,
    readiness: { checking, answer: checking ? advisory : undefined, recheck },
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
      {returnGuarded ? (
        <div className="flex flex-col gap-2">
          <a
            className="inline-flex min-h-11 items-center self-start underline"
            href={finishHref}
            onClick={(event) => {
              event.preventDefault();
              if (leaving === 'going') return;
              if (preparing === 0 && hasUnsent()) setLeaving('choosing');
              else returnToFinish();
            }}
          >
            Back to Finish and review
          </a>
          {leaving === 'choosing' ? (
            <div role="alert" className="flex flex-col gap-2 rounded-md border border-foreground/40 p-3 text-sm">
              <p>Some changes are not saved. Save them first, or discard them and go back to Finish and review.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setLeaving('no')}>
                  Keep editing
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    for (const form of unsavedForms.current.values()) form.discard();
                    pending.discardUnsent(jobId);
                    returnToFinish();
                  }}
                >
                  Discard changes and go back
                </Button>
              </div>
            </div>
          ) : null}
          {leaving === 'going' && writing ? (
            <div className="flex flex-col gap-2 text-sm">
              <p role="status">Saving…</p>
              <Button variant="outline" className="self-start" onClick={() => setLeaving('no')}>
                Keep editing
              </Button>
            </div>
          ) : null}
          {leaving === 'blocked' ? (
            <p role="alert" className="text-sm">Could not confirm that the changes were saved. Check the job for changes to retry, then try returning again.</p>
          ) : null}
        </div>
      ) : null}
      {archived ? <ArchivedNotice session={session} jobId={jobId} /> : null}
      {moved ? (
        <p role="alert" className="rounded-md bg-foreground/5 p-3 text-sm">
          {MOVED_TEXT}
        </p>
      ) : null}
      {onDraftViews && startable && detail ? <StartFieldWork context={{ ...context, detail }} /> : null}
      {onDraftViews && gettingReady && !moved && !archived ? (
        prepareTries < PREPARE_TRIES ? (
          <p role="status" className="rounded-md bg-foreground/5 p-3 text-sm">
            Getting this job&rsquo;s field work ready&hellip;
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p role="alert">This job&rsquo;s field work is not ready on this phone yet. Try again in a moment.</p>
            <Button variant="outline" onClick={() => { setPrepareTries(0); void reloadJob(); }}>
              Try again
            </Button>
          </div>
        )
      ) : null}
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
      <div hidden={view !== 'scope'}>{draft ? <ScopeView key={draftAt} job={context} draft={draft} open={view === 'scope'} readinessFix={fix ? readinessFix : null} /> : null}</div>
      <div hidden={view !== 'photos'}>{draft ? <PhotosView key={draftAt} job={context} draft={draft} open={view === 'photos'} readinessFix={fix ? readinessFix : null} /> : null}</div>
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
