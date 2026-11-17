'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  assignEstimator,
  readCoordination,
  saveCoordination,
  transferFieldOwner,
  unassignEstimator,
  type Answer,
  type CoordinationView as View,
  type JobDetail,
  type Person,
} from '@/lib/field/api';
import { pending, usePending, type CoordRequest } from '@/lib/field/pending';
import type { JobContext } from './job-screens';
import { Choice, Outcome, Section } from './ui';

const MAX_NOTES = 4000;

const nameOf = (person: Person) => person.displayName || person.email;

function send(user: JobContext['session']['user'], jobId: string, request: CoordRequest): Promise<Answer<View>> {
  switch (request.kind) {
    case 'move':
      return transferFieldOwner(user, jobId, { revision: request.revision, changeId: request.changeId, toActorId: request.toActorId });
    case 'assign':
      return assignEstimator(user, jobId, { id: request.id, estimatorActorId: request.estimatorActorId });
    case 'unassign':
      return unassignEstimator(user, jobId, request.assignmentId);
    case 'notes':
      return saveCoordination(user, jobId, { revision: request.revision, changeId: request.changeId, notes: request.notes });
  }
}

// Job coordination (S5b-1): what the owner and office keep beside the customer view, read from the
// jobs API. Office notes (`coordination`), the estimators assigned (`assignment`), and who owns the
// field work, which the owner alone moves (owner decision J5, `field_owner_transfer`). An estimator
// never sees any of it (docs/spec.md 2.3); the server refuses them too.
export function CoordinationView({ job, open }: { job: JobContext & { detail: JobDetail }; open: boolean }) {
  const caps = job.session.capabilities;
  const mayView = caps.includes('coordination') || caps.includes('assignment');
  const { user } = job.session;
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Asked for when the view is first opened, and again for each "Try again" or stale answer.
  const [asked, setAsked] = useState(0);
  const [answered, setAnswered] = useState(0);
  // A write answered after this screen was opened again (it settled in the page's unsent work) changes
  // what this screen read: read again.
  const settled = usePending(() => pending.coordSettled(job.jobId));
  const [seen, setSeen] = useState(settled);
  if (seen !== settled) {
    setSeen(settled);
    setAsked((count) => count + 1);
  }
  const wanted = open && mayView && job.session.online && asked >= answered;

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void readCoordination(user, job.jobId).then((answer) => {
      if (!live) return;
      setAnswered(asked + 1);
      if (answer.ok) {
        setView(answer.value);
        setLoadError(null);
      } else {
        setLoadError(answer.message);
      }
    });
    return () => {
      live = false;
    };
  }, [wanted, asked, user, job.jobId]);

  if (!mayView) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">Job coordination</h3>
        <p>Job coordination is kept by the office and the company owner.</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">Job coordination</h3>
        {!job.session.online ? (
          <p role="status">Needs a connection</p>
        ) : loadError ? (
          <>
            <p role="alert">{loadError}</p>
            <Button variant="outline" onClick={() => setAsked((count) => count + 1)}>
              Try again
            </Button>
          </>
        ) : (
          <p role="status">Reading job coordination…</p>
        )}
      </div>
    );
  }
  return <Coordination job={job} view={view} setView={setView} reread={() => setAsked((count) => count + 1)} />;
}

function Coordination({ job, view, setView, reread }: { job: JobContext & { detail: JobDetail }; view: View; setView: (view: View) => void; reread: () => void }) {
  const caps = job.session.capabilities;
  const { jobId, session } = job;
  const { user } = session;
  // A write with no answer yet is kept with its ids in the page's unsent work (src/lib/field/pending.ts),
  // so it survives leaving and opening the job again, and nothing else is sent until it settles: a retry
  // is the same request, never a second assignment, a second move or a conflict with itself.
  const held = usePending(() => pending.coordWrite(jobId));
  const [error, setError] = useState<{ at: string; message: string } | null>(null);
  const [notice, setNotice] = useState<{ at: string; message: string } | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [moveTo, setMoveTo] = useState('');

  // Sends `request`, or the held one again after no answer. Answers whether it was done.
  async function act(at: string, key: string, request: CoordRequest, done: string): Promise<boolean> {
    const current = pending.coordWrite(jobId);
    if (current && (current.key !== key || current.sending)) return false;
    if (!session.online) {
      setError({ at, message: 'Needs a connection' });
      return false;
    }
    const attempt = { ...(current ?? { key, at, done, request }), sending: true };
    pending.setCoordWrite(jobId, attempt);
    setError(null);
    setNotice(null);
    const answer = await send(user, jobId, attempt.request);
    // No answer, or a 503 (saved, but its field draft step did not get through): kept to send again
    // as it was. Any other answer settles it.
    const unanswered = !answer.ok && (answer.status === 0 || answer.status === 503);
    if (!pending.settleCoordWrite(jobId, attempt.key, unanswered ? 'unanswered' : 'answered')) return false;
    if (answer.ok) {
      // Every path of a retry ends the same way: what was typed for this request is the view's now.
      const sentNotes = attempt.request.kind === 'notes' ? attempt.request.notes : null;
      if (sentNotes !== null) setNotes((current) => (current === sentNotes ? null : current));
      setView(answer.value);
      setNotice({ at: attempt.at, message: attempt.done });
      // The job's field owner may have moved with it: the other views read the job again.
      await job.reloadJob();
      return true;
    }
    setError({ at: attempt.at, message: answer.message });
    if (answer.stale || answer.status === 404 || answer.code === 'assignment_not_found') reread();
    return false;
  }
  // The held write sent again, from whichever control of it is on screen.
  const retry = () => (held ? act(held.at, held.key, held.request, held.done) : Promise.resolve(false));
  const heldKind = held?.request.kind ?? null;
  const waiting = held?.sending ?? false;
  const heldMove = held?.request.kind === 'move' ? held.request : null;
  const heldAssign = held?.request.kind === 'assign' ? held.request : null;
  const everyone = [...view.estimators, ...view.assignments, ...(view.fieldOwner ? [view.fieldOwner] : [])];
  const labelOf = (actorId: string) => (actorId === session.actorId ? 'Me (company owner)' : (everyone.filter((one) => one.actorId === actorId).map(nameOf)[0] ?? 'The person chosen'));
  const other = (kind: CoordRequest['kind']) => held !== null && heldKind !== kind;

  const assigned = new Set(view.assignments.map((one) => one.actorId));
  const free = view.estimators.filter((one) => !assigned.has(one.actorId));
  const ownerId = session.actorId;
  const targets = [
    ...(view.fieldOwner?.actorId !== ownerId ? [{ value: ownerId, label: 'Me (company owner)' }] : []),
    ...view.assignments.filter((one) => one.actorId !== view.fieldOwner?.actorId).map((one) => ({ value: one.actorId, label: nameOf(one) })),
  ];
  // What is sent is what the box shows: a choice no longer offered falls back to the first one.
  const moveChoice = targets.some((one) => one.value === moveTo) ? moveTo : targets[0]?.value;
  const pickChoice = free.some((one) => one.actorId === pick) ? pick : free[0]?.actorId;
  const typedNotes = held?.request.kind === 'notes' ? held.request.notes : (notes ?? view.notes);
  const errorAt = (at: string) => (error?.at === at ? error.message : null);
  const noticeAt = (at: string) => (notice?.at === at ? notice.message : null);
  const mayMove = caps.includes('field_owner_transfer') && view.status !== 'signed' && view.status !== 'archived' && (targets.length > 0 || heldMove !== null);
  const notesHeld = held?.request.kind === 'notes';

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold">Job coordination</h3>
      {held ? (
        <Section title="Change not answered yet">
          <p>
            {{ move: 'A move of the field work', assign: 'Assigning an estimator', unassign: 'Unassigning an estimator', notes: 'Saving the notes' }[held.request.kind]} was
            sent and no answer came back. It is sent again exactly as it was, and nothing else is sent until it is answered.
          </p>
          <Button type="button" disabled={waiting || !session.online} onClick={() => void retry()}>
            {waiting ? 'Sending…' : 'Send the unanswered change again'}
          </Button>
          <Outcome error={errorAt(held.at)} notice={null} />
        </Section>
      ) : null}
      <Section title="Field work">
        <p>{view.fieldOwner ? `${nameOf(view.fieldOwner)} owns the field work.` : 'Nobody has started the field work yet. The first assigned estimator to start it owns it.'}</p>
        {mayMove ? (
          <form
            aria-labelledby="move-heading"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (heldKind === 'move') return void retry();
              const to = moveChoice!;
              const request = { kind: 'move' as const, revision: view.revision, changeId: crypto.randomUUID(), toActorId: to };
              void act('move', `move:${to}`, request, 'The field work was moved.').then((ok) => {
                if (ok) setMoveTo((current) => (current === to ? '' : current));
              });
            }}
          >
            <h4 id="move-heading" className="font-medium">
              Move the field work
            </h4>
            <p className="text-sm">
              Only the new owner can change the field work from then on. Changes not yet sent from the phone that held it stay on that phone, read
              only, and are not saved to this job.
            </p>
            <Choice id="move-to" label="Move it to" value={heldMove ? heldMove.toActorId : moveChoice!} options={heldMove ? [{ value: heldMove.toActorId, label: labelOf(heldMove.toActorId) }] : targets} onChange={setMoveTo} readOnly={heldMove !== null} />
            <Button type="submit" disabled={waiting || other('move') || !session.online}>
              {waiting && heldKind === 'move' ? 'Moving…' : heldKind === 'move' ? 'Try again' : 'Move field work'}
            </Button>
            <Outcome error={errorAt('move')} notice={noticeAt('move')} />
          </form>
        ) : null}
      </Section>

      <Section title="Assigned estimators">
        {view.assignments.length === 0 ? (
          <p>No estimator is assigned yet.</p>
        ) : (
          <ul aria-label="Assigned estimators" className="flex flex-col gap-2">
            {view.assignments.map((one) => (
              <li key={one.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-words">
                  {nameOf(one)}
                  {view.fieldOwner?.actorId === one.actorId ? ' (owns the field work)' : ''}
                </span>
                {caps.includes('assignment') && view.fieldOwner?.actorId !== one.actorId ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={waiting || (held !== null && held.key !== `unassign:${one.id}`) || !session.online}
                    aria-label={`Unassign ${nameOf(one)}`}
                    onClick={() =>
                      void act('assign', `unassign:${one.id}`, { kind: 'unassign', assignmentId: one.id }, `${nameOf(one)} was unassigned.`)
                    }
                  >
                    Unassign
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {caps.includes('assignment') ? (
          free.length === 0 && !heldAssign ? (
            <p className="text-sm">Every active estimator is assigned to this job.</p>
          ) : (
            <form
              aria-labelledby="assign-heading"
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (heldKind === 'assign') return void retry();
                const estimator = pickChoice!;
                const request = { kind: 'assign' as const, id: crypto.randomUUID(), estimatorActorId: estimator };
                void act('assign', `assign:${estimator}`, request, 'The estimator was assigned.').then((ok) => {
                  if (ok) setPick((current) => (current === estimator ? '' : current));
                });
              }}
            >
              <h4 id="assign-heading" className="font-medium">
                Assign estimator
              </h4>
              <Choice
                id="assign-estimator"
                label="Estimator"
                value={heldAssign ? heldAssign.estimatorActorId : pickChoice!}
                options={heldAssign ? [{ value: heldAssign.estimatorActorId, label: labelOf(heldAssign.estimatorActorId) }] : free.map((one) => ({ value: one.actorId, label: nameOf(one) }))}
                onChange={setPick}
                readOnly={heldAssign !== null}
              />
              <Button type="submit" disabled={waiting || other('assign') || !session.online}>
                {waiting && heldKind === 'assign' ? 'Assigning…' : heldKind === 'assign' ? 'Try again' : 'Assign estimator'}
              </Button>
            </form>
          )
        ) : null}
        <Outcome error={errorAt('assign')} notice={noticeAt('assign')} />
      </Section>

      <Section title="Office notes">
        <form
          aria-labelledby="notes-label"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (heldKind === 'notes') return void retry();
            const request = { kind: 'notes' as const, revision: view.revision, changeId: crypto.randomUUID(), notes: typedNotes };
            void act('notes', `notes:${typedNotes}`, request, 'Notes saved.').then((ok) => {
              if (ok) setNotes((current) => (current === request.notes ? null : current));
            });
          }}
        >
          <label id="notes-label" htmlFor="office-notes" className="text-sm font-medium">
            Office notes
          </label>
          <p id="office-notes-hint" className="text-sm">
            Only the office and the company owner see these notes.
          </p>
          <textarea
            id="office-notes"
            name="notes"
            rows={5}
            maxLength={MAX_NOTES}
            readOnly={!caps.includes('coordination') || notesHeld}
            aria-describedby="office-notes-hint"
            value={typedNotes}
            onChange={(event) => {
              setNotes(event.target.value);
              setNotice(null);
            }}
            className="w-full rounded-md border border-foreground/40 bg-background p-3 text-base read-only:bg-foreground/5"
          />
          {caps.includes('coordination') ? (
            <Button type="submit" disabled={waiting || other('notes') || !session.online}>
              {waiting && notesHeld ? 'Saving…' : notesHeld ? 'Try again' : 'Save notes'}
            </Button>
          ) : null}
          <Outcome error={errorAt('notes')} notice={noticeAt('notes')} />
        </form>
      </Section>
    </div>
  );
}
