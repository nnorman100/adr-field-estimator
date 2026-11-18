'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fieldUser } from '@/lib/field-db';
import { readJob } from '@/lib/field/api';
import type { DsMe } from '@/lib/field/ds-me';
import { watchJournal, type JournalEntry } from '@/lib/field/journal';
import { discardEntries, journalFailed, readEntries, tryAgain } from '@/lib/field/journal-sync';
import { saveAsNewDraft } from '@/lib/field/new-draft';
import { pending } from '@/lib/field/pending';
import { byDraft, changedFields, chipText, keptText, PHOTOS_STAY, REASONS, RESTORE_FIRST, syncStatus, type Problem, type SyncStatus } from '@/lib/field/sync-status';
import { useFieldClient } from './field-store';
import { photoReferenceDone } from './photos-view';
import { go, Outcome } from './ui';

// The sync chip on every field screen and its "Can't save" sheet (S6-4b; docs/plans/S6/S6-4.md),
// read from the person's recovery journal (src/lib/field/journal.ts; with an Online only cache, the
// one this page holds in memory) and read again each time it changes on this page. It matches the
// job screens' Archive (./job-actions.tsx): native modal dialogs (modern-web-guidance "dialog"), and
// a confirm whose safe choice has the focus.

export const SHEET_TITLE = 'Changes not saved';
export const DISCARD_TITLE = 'Discard these changes?';
export const DISCARD_CONFIRM = 'Discard changes';
export const DISCARD_KEEP = 'Keep them';
export const SAVE_AS_NEW = 'Save as new draft';
export const SAVE_AS_ANOTHER = 'Save as another new draft';

// How a panel names its job: the address this page last read for it, else the start of its id; none
// once the server refused this person the job (no access), so nothing of it is shown.
function jobLabel(problem: Problem): string | null {
  if (problem.reason === 'no-access') return null;
  const address = problem.jobId ? pending.detail(problem.jobId)?.job.propertyAddress : '';
  if (address) return address;
  return problem.jobId ? `Job ${problem.jobId.slice(0, 8)}` : `Draft ${problem.draftPath.split('/').at(-1)?.slice(0, 8) ?? ''}`;
}

export function SyncChip({ me }: { me: DsMe }) {
  const field = useFieldClient();
  const client = field?.client ?? null;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  // How many times the sheet was opened: each opening asks the server again what it offers.
  const [opened, setOpened] = useState(0);
  const sheet = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const canSaveAsNew =
    field?.me.capabilities.includes('jobs_create') === true &&
    field.me.capabilities.includes('scope');

  // A read answers only while no newer one has started.
  const reads = useRef(0);
  const load = useCallback(async () => {
    if (!client) return;
    const mine = ++reads.current;
    try {
      const entries = await readEntries(client);
      if (mine === reads.current) setStatus(syncStatus(entries, canSaveAsNew));
    } catch (error) {
      // The journal did not answer: the chip keeps what it last said, and a storage connection lost
      // twice goes to the shell, which says "Reopen the app".
      journalFailed(client, error);
    }
  }, [client, canSaveAsNew]);

  // The gate opening (or closing) changes what a refusal's reason and the job's state read as.
  const online = field?.online ?? false;
  useEffect(() => {
    if (!client) return;
    // Read after this render, as the job screens do.
    void Promise.resolve().then(load);
    const stop = watchJournal(
      { tenantId: client.person.tenantId, uid: client.person.uid },
      () => void load(),
    );
    const shown = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', shown);
      reads.current += 1;
    };
  }, [client, load, online]);

  const problems = status?.problems ?? [];
  // The sheet closes once its last problem has cleared.
  useEffect(() => {
    if (problems.length === 0 && sheet.current?.open) sheet.current.close();
  }, [problems.length]);

  if (!client || !status) return null;
  const text = chipText(status);

  return (
    <div>
      <div role="status" aria-label="Sync">
        {problems.length > 0 ? (
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-full border border-input bg-accent px-4 text-base font-medium"
            onClick={() => {
              setOpened((count) => count + 1);
              sheet.current?.showModal();
            }}
          >
            {text}
          </button>
        ) : (
          <p className="inline-flex min-h-11 items-center rounded-full border border-input px-4 text-base">
            {text}
          </p>
        )}
      </div>
      <dialog
        ref={sheet}
        aria-labelledby={titleId}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-input bg-background p-6 text-foreground backdrop:overflow-hidden backdrop:overscroll-contain backdrop:bg-black/40"
      >
        <h2 id={titleId} className="text-xl font-semibold">
          {SHEET_TITLE}
        </h2>
        <div className="mt-3 flex flex-col gap-6">
          {problems.map((problem) => (
            <ProblemPanel
              key={problem.key}
              problem={problem}
              me={me}
              online={online}
              opened={opened}
              onLeave={() => sheet.current?.close()}
            />
          ))}
        </div>
        <form method="dialog" className="mt-4 flex flex-col">
          <Button variant="outline" value="">
            Close
          </Button>
        </form>
      </dialog>
    </div>
  );
}

function ProblemPanel({
  problem,
  me,
  online,
  opened,
  onLeave,
}: {
  problem: Problem;
  me: DsMe;
  online: boolean;
  opened: number;
  onLeave: () => void;
}) {
  const field = useFieldClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const textId = useId();
  const words = REASONS[problem.reason];
  const client = field?.client;
  const count = problem.entries.length;
  const label = jobLabel(problem);
  // Once the new draft for these edits holds other work: they can go into another one of their own.
  const [another, setAnother] = useState(false);

  // A finished job: Finish and review is offered once the job answers (it opens there), and an
  // archived one (410) says the owner must restore it first; asked again at each opening of the
  // sheet, and only that opening's answer counts.
  const [finish, setFinish] = useState<{ opened: number; open: boolean } | null>(null);
  const finishOpen = finish?.opened === opened ? finish.open : null;
  const finishedJob = problem.reason === 'finished' ? problem.jobId : null;
  useEffect(() => {
    const user = client ? fieldUser(client.person) : null;
    if (!finishedJob || !online || !user) return;
    let live = true;
    void readJob(user, finishedJob).then((answer) => {
      if (live && (answer.ok || answer.status === 410)) setFinish({ opened, open: answer.ok });
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [client, finishedJob, online, opened]);

  async function run(label: string, work: () => Promise<string | null>) {
    if (!client || busy) return;
    setBusy(label);
    setError(null);
    try {
      setError(await work());
    } catch (error) {
      journalFailed(client, error);
      setError('This phone could not do that just now. Try again.');
    } finally {
      setBusy(null);
    }
  }

  // A photo reference these edits set leaves the photos being sent: it was sent, or discarded.
  const photosDone = (edits: readonly JournalEntry[]) => {
    const jobId = edits.find((entry) => entry.jobId)?.jobId;
    if (!client || !jobId) return;
    for (const write of edits.flatMap((entry) => entry.writes)) {
      const photo = /\/photos\/([^/]+)$/.exec(write.path)?.[1];
      if (photo && write.op === 'set') photoReferenceDone(client, jobId, photo);
    }
  };

  // The edits are saved: the job's open screen reads the job and its draft again (the job was
  // restored, or its field work came back).
  const sent = (edits: readonly JournalEntry[]) => {
    const jobId = edits.find((entry) => entry.jobId)?.jobId;
    if (!client || !jobId) return;
    pending.returned(jobId);
    pending.verify(jobId);
    photosDone(edits);
  };

  const again = () =>
    run('Sending again…', async () => {
      if (!online) return 'Needs a connection';
      const answers: string[] = [];
      for (const edits of byDraft(problem.entries)) {
        const answer = await tryAgain(client!, edits);
        answers.push(answer);
        if (answer === 'sent') sent(edits);
      }
      if (answers.includes('no-answer')) return 'No answer from DryScope. Check the signal and try again.';
      if (answers.includes('refused')) return 'Still can’t save: the reason above still holds.';
      return null;
    });

  const saveAsNew = () =>
    run('Saving as a new draft…', async () => {
      if (!online) return 'Needs a connection';
      let made: string | null = null;
      for (const edits of byDraft(problem.entries)) {
        const answer = await saveAsNewDraft(client!, edits, another);
        if (answer.kind === 'saved') made = answer.jobId;
        else if (answer.kind === 'not-kept') return 'This job’s field work is not kept on this phone, so there is nothing to copy.';
        else if (answer.kind === 'exists') {
          setAnother(true);
          return 'A new draft was already saved from this job. Save these changes as another new draft, or discard them.';
        }
        else if (answer.kind === 'no-answer') return 'No answer from DryScope. Try again: it makes the same new draft.';
        else return answer.message;
      }
      if (made) {
        onLeave();
        go({ view: 'scope', jobId: made });
      }
      return null;
    });

  const discard = () =>
    run('Discarding…', async () => {
      await discardEntries(client!, problem.entries);
      photosDone(problem.entries);
      return null;
    });

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-lg font-semibold">
        {words.title}
      </h3>
      <p id={textId} className="text-base">
        {finishOpen === false ? RESTORE_FIRST : words.text}
      </p>
      <p className="text-sm">
        {label ? `${label}: ` : ''}
        {count === 1 ? '1 change' : `${count} changes`}. {keptText(client?.cache === 'persistent')}
      </p>
      {problem.reason === 'changed' ? (
        <ul className="list-disc pl-6 text-base" aria-label="Changed fields">
          {changedFields(problem.entries).map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}
      {problem.saveAsNew ? (
        <>
          <Button disabled={busy !== null || !online} onClick={() => void saveAsNew()}>
            {another ? SAVE_AS_ANOTHER : SAVE_AS_NEW}
          </Button>
          <p className="text-sm">{PHOTOS_STAY}</p>
        </>
      ) : null}
      {problem.tryAgain ? (
        <Button variant="outline" disabled={busy !== null || !online} onClick={() => void again()}>
          Try again
        </Button>
      ) : null}
      {finishOpen === true && problem.jobId ? (
        <a
          className="inline-flex min-h-11 items-center text-base font-medium underline"
          href={`/sign-in/${me.address}/jobs/${problem.jobId}/finish`}
        >
          Go to Finish and review
        </a>
      ) : null}
      <Button
        variant="outline"
        disabled={busy !== null}
        onClick={() => confirm.current?.showModal()}
      >
        Discard
      </Button>
      {(problem.saveAsNew || problem.tryAgain) && !online ? (
        <p className="text-sm">Needs a connection</p>
      ) : null}
      <Outcome error={error} notice={busy} />
      <dialog
        ref={confirm}
        aria-labelledby={`${titleId}-confirm`}
        aria-describedby={`${textId}-confirm`}
        onClose={(event) => {
          const value = event.currentTarget.returnValue;
          event.currentTarget.returnValue = '';
          if (value === 'discard') void discard();
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md overscroll-contain rounded-2xl border border-input bg-background p-6 text-foreground backdrop:overflow-hidden backdrop:overscroll-contain backdrop:bg-black/40"
      >
        <h2 id={`${titleId}-confirm`} className="text-xl font-semibold">
          {DISCARD_TITLE}
        </h2>
        <p id={`${textId}-confirm`} className="mt-3 text-base">
          {count === 1 ? 'The change' : `The ${count} changes`} to {label ?? 'this job'} will be removed from this
          phone. What DryScope already has is not changed. This cannot be undone.
        </p>
        <form method="dialog" className="mt-4 flex flex-col gap-2">
          <Button autoFocus variant="outline" value="">
            {DISCARD_KEEP}
          </Button>
          <Button value="discard">{DISCARD_CONFIRM}</Button>
        </form>
      </dialog>
    </section>
  );
}
