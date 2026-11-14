'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { BrowserSignInConfig } from '@/lib/config';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { signOutOfCompany } from '@/lib/field/sign-out';
import { belongsTo, callApi, companyAuth } from '@/lib/firebase-client';
import { endsSession, meOutcome } from '@/lib/sign-in/outcome';
import { fieldDatabase, readShownDraft } from '@/lib/submissions/field-reader';
import { draftSummary, finisherOf, jobOf, outcomeOf, type JobOnScreen, type Next } from '@/lib/submissions/screen';
import { FocusedPanel } from '../../../../../focused-panel';
import { Panel } from '../../../../../panel';

export type FinishScreenProps = {
  address: string;
  companyName: string;
  tenantId: string;
  jobId: string;
  // null when sign-in is not set up for this environment yet.
  config: BrowserSignInConfig | null;
};

type Ready = { user: User; companyId: string; canFinish: boolean; job: JobOnScreen; manifest: FieldManifest | null };

type Phase =
  | { name: 'checking' }
  | { name: 'signed-out' }
  | { name: 'finish-sign-in' }
  | { name: 'unavailable' }
  | { name: 'not-found' }
  | ({ name: 'ready' } & Ready);

// A refusal or failure shown above the actions, and what the person can do next.
type Problem = { message: string; next: Next };

export function FinishScreen(props: FinishScreenProps) {
  if (!props.config) {
    return (
      <Panel title="Finish and review">
        <p>Sign-in is not set up here yet. Try again later.</p>
      </Panel>
    );
  }
  return <Finish key={`${props.tenantId}/${props.jobId}`} {...props} config={props.config} />;
}

function Finish({ address, companyName, tenantId, jobId, config }: FinishScreenProps & { config: BrowserSignInConfig }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const authRef = useRef<Auth | null>(null);

  // Reads who is signed in, the job and (while it is being edited) its draft, from the server.
  const load = useCallback(
    async (user: User) => {
      const stale = () => authRef.current?.currentUser !== user;
      setPhase({ name: 'checking' });
      const me = await callApi(user, '/api/me');
      if (stale()) return;
      const outcome = meOutcome(me.status, me.body);
      if (endsSession(outcome)) {
        await signOutOfCompany(authRef.current!, tenantId).catch(() => setPhase({ name: 'unavailable' }));
        return;
      }
      if (outcome.kind === 'unavailable') return setPhase({ name: 'unavailable' });
      if (outcome.kind !== 'signed-in') return setPhase({ name: 'finish-sign-in' });
      const who = finisherOf(me.body);
      if (!who) return setPhase({ name: 'unavailable' });
      const answer = await callApi(user, `/api/jobs/${encodeURIComponent(jobId)}`);
      if (stale()) return;
      if (answer.status === 404 || answer.status === 410) return setPhase({ name: 'not-found' });
      const job = answer.status === 200 ? jobOf(answer.body) : null;
      if (!job) return setPhase({ name: 'unavailable' });
      let manifest: FieldManifest | null = null;
      if (job.status === 'draft') {
        const db = fieldDatabase(authRef.current!.app, config);
        const shown = db ? await readShownDraft(db, who.companyId, job.currentDraftId).catch(() => null) : null;
        if (stale()) return;
        if (!shown) return setPhase({ name: 'unavailable' });
        manifest = shown.manifest;
      }
      setPhase({ name: 'ready', user, companyId: who.companyId, canFinish: who.canFinish, job, manifest });
    },
    [config, jobId, tenantId],
  );

  useEffect(() => {
    const auth = companyAuth({ config, tenantId });
    authRef.current = auth;
    return onAuthStateChanged(auth, (user) => {
      if (!user) return setPhase({ name: 'signed-out' });
      if (!belongsTo(user, tenantId)) return void signOutOfCompany(auth, tenantId).catch(() => setPhase({ name: 'unavailable' }));
      void load(user);
    });
  }, [config, tenantId, load]);

  const signInLink = (
    <Button asChild variant="outline">
      <Link href={`/sign-in/${address}`}>Go to the {companyName} sign-in page</Link>
    </Button>
  );

  switch (phase.name) {
    case 'checking':
      return (
        <FocusedPanel title="Finish and review">
          <p role="status">Reading the job…</p>
        </FocusedPanel>
      );
    case 'signed-out':
      return (
        <FocusedPanel title="Sign in to finish this job">
          <p>Sign in to {companyName} first.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'finish-sign-in':
      return (
        <FocusedPanel title="Finish signing in first">
          <p>Your sign-in is not finished yet. The sign-in page shows the next step.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'not-found':
      return (
        <FocusedPanel title="This job could not be found">
          <p>It may belong to someone else, or it was archived.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'unavailable':
      return (
        <FocusedPanel title="We could not open this job">
          <p>Finish and review needs a connection. Check it, then try again.</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
          {signInLink}
        </FocusedPanel>
      );
    case 'ready':
      return <FinishActions {...phase} reviewHref={`/sign-in/${address}/jobs/${encodeURIComponent(jobId)}/review`} reload={() => void load(phase.user)} />;
  }
}

function FinishActions({ user, canFinish, job, manifest, reviewHref, reload }: Ready & { reviewHref: string; reload: () => void }) {
  const [current, setCurrent] = useState<JobOnScreen>(job);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The id of the request in flight, kept until it is answered, so a retry after a lost answer is the
  // same request and never a second record or a second draft.
  const pendingSubmit = useRef<{ id: string; digest: string; draftId: string } | null>(null);
  const pendingDraft = useRef<{ draftId: string; fromDraftId: string } | null>(null);

  async function finish() {
    if (!manifest) return;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    pendingSubmit.current ??= { id: crypto.randomUUID(), digest: await manifestDigest(manifest), draftId: current.currentDraftId };
    const answer = await callApi(user, `/api/jobs/${encodeURIComponent(current.id)}/submissions`, { method: 'POST', json: pendingSubmit.current });
    setBusy(false);
    const next = answer.status === 200 || answer.status === 201 ? jobOf(answer.body) : null;
    if (next) {
      pendingSubmit.current = null;
      setCurrent(next);
      setNotice('Finished. The draft is saved as a record and locked.');
      return;
    }
    const outcome = outcomeOf(answer.status, answer.body);
    if (outcome.next !== 'retry') pendingSubmit.current = null;
    setProblem(outcome);
  }

  async function backToEditing() {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    pendingDraft.current ??= { draftId: crypto.randomUUID(), fromDraftId: current.currentDraftId };
    const answer = await callApi(user, `/api/jobs/${encodeURIComponent(current.id)}/drafts`, { method: 'POST', json: pendingDraft.current });
    setBusy(false);
    const next = answer.status === 200 || answer.status === 201 ? jobOf(answer.body) : null;
    if (next) {
      pendingDraft.current = null;
      setCurrent(next);
      setNotice('A new draft version is ready to edit. Finish and review it again when it is done.');
      return;
    }
    const outcome = outcomeOf(answer.status, answer.body);
    if (outcome.next !== 'retry') pendingDraft.current = null;
    setProblem(outcome);
  }

  const summary = manifest ? draftSummary(manifest) : null;
  const editing = current.status === 'draft';
  const submitted = current.status === 'submitted';
  const title = editing ? 'Finish and review' : submitted ? 'Finished' : 'This job is signed';

  return (
    <FocusedPanel title={title}>
      {problem ? (
        <div role="alert" className="flex flex-col gap-3 rounded-md border border-red-700 p-3">
          <p>{problem.message}</p>
          {problem.next === 'retry' ? (
            <Button disabled={busy} onClick={() => void (editing ? finish() : backToEditing())}>
              Try again
            </Button>
          ) : null}
          {problem.next === 'reload' ? (
            <Button variant="outline" disabled={busy} onClick={reload}>
              Reload the job
            </Button>
          ) : null}
        </div>
      ) : null}
      <p role="status">{busy ? 'Saving…' : (notice ?? '')}</p>

      {editing && summary && !(notice && current.currentDraftId !== job.currentDraftId) ? (
        <section aria-labelledby="finish-draft" className="flex flex-col gap-2">
          <h2 id="finish-draft" className="text-lg font-semibold">
            What will be recorded
          </h2>
          <ul className="list-disc pl-5">
            <li>
              {summary.rooms.length === 1 ? '1 room' : `${summary.rooms.length} rooms`}
              {summary.rooms.length > 0 ? `: ${summary.rooms.join(', ')}` : ''}
            </li>
            {summary.unnamedRooms > 0 ? <li>{summary.unnamedRooms === 1 ? '1 room has no name' : `${summary.unnamedRooms} rooms have no name`}</li> : null}
            <li>{summary.photos === 1 ? '1 photo' : `${summary.photos} photos`}</li>
            <li>{summary.summaryWritten ? 'Summary of findings written' : 'No summary of findings yet'}</li>
          </ul>
        </section>
      ) : null}

      {editing && canFinish && manifest && current.currentDraftId === job.currentDraftId ? (
        <>
          <p className="text-sm">
            Finishing saves this draft as the job&apos;s record and locks it, on every phone. The review comes next. To change the job
            afterwards, use Back to editing. Finish needs a connection.
          </p>
          <Button disabled={busy} onClick={() => void finish()}>
            Finish and review
          </Button>
        </>
      ) : null}

      {editing && current.currentDraftId !== job.currentDraftId ? (
        <Button variant="outline" disabled={busy} onClick={reload}>
          Show the new draft
        </Button>
      ) : null}

      {submitted ? (
        <>
          <p>This draft is recorded and locked. Nobody can change it.</p>
          <Button asChild>
            <Link href={reviewHref}>Review the estimate</Link>
          </Button>
          {canFinish ? (
            <>
              <p className="text-sm">
                Back to editing makes a new draft version from this record. The review of this version no longer counts, and the new
                version needs Finish and review again.
              </p>
              <Button variant="outline" disabled={busy} onClick={() => void backToEditing()}>
                Back to editing
              </Button>
            </>
          ) : null}
        </>
      ) : null}

      {!canFinish && editing ? <p>Only the owner or the estimator on this job can finish it.</p> : null}
    </FocusedPanel>
  );
}
