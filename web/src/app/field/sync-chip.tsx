'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DsMe } from '@/lib/field/ds-me';
import { watchJournal } from '@/lib/field/journal';
import { discardEntries, journalFailed, readEntries, tryAgain } from '@/lib/field/journal-sync';
import { saveAsNewDraft } from '@/lib/field/new-draft';
import { pending } from '@/lib/field/pending';
import { chipText, PHOTOS_STAY, REASONS, SAVED_ON_PHONE, syncStatus, type Problem, type SyncStatus } from '@/lib/field/sync-status';
import { useFieldClient } from './field-store';
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

// How a panel names its job: the address this page last read for it, else the start of its id.
function jobLabel(problem: Problem): string {
  const address = problem.jobId ? pending.detail(problem.jobId)?.job.propertyAddress : '';
  if (address) return address;
  return problem.jobId ? `Job ${problem.jobId.slice(0, 8)}` : `Draft ${problem.draftPath.split('/').at(-1)?.slice(0, 8) ?? ''}`;
}

export function SyncChip({ me }: { me: DsMe }) {
  const field = useFieldClient();
  const client = field?.client ?? null;
  const [status, setStatus] = useState<SyncStatus | null>(null);
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
            onClick={() => sheet.current?.showModal()}
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
              key={`${problem.draftPath}/${problem.reason}`}
              problem={problem}
              me={me}
              online={online}
              onLeave={() => sheet.current?.close()}
            />
          ))}
          {status.waiting > 0 ? (
            <p className="text-base">
              {SAVED_ON_PHONE} ({status.waiting} waiting to send)
            </p>
          ) : null}
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
  onLeave,
}: {
  problem: Problem;
  me: DsMe;
  online: boolean;
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

  const again = () =>
    run('Sending again…', async () => {
      if (!online) return 'Needs a connection';
      const answer = await tryAgain(client!, problem.entries);
      if (answer === 'no-answer') return 'No answer from DryScope. Check the signal and try again.';
      if (answer === 'refused') return 'Still can’t save: the reason above still holds.';
      // The job's open screen reads its draft again, as after a photo sent from a closed screen.
      if (answer === 'sent' && problem.jobId) pending.draftChanged(problem.jobId);
      return null;
    });

  const saveAsNew = () =>
    run('Saving as a new draft…', async () => {
      if (!online) return 'Needs a connection';
      const answer = await saveAsNewDraft(client!, problem.entries);
      if (answer.kind === 'saved') {
        onLeave();
        go({ view: 'scope', jobId: answer.jobId });
        return null;
      }
      if (answer.kind === 'not-kept')
        return 'This job’s field work is not kept on this phone, so there is nothing to copy.';
      if (answer.kind === 'no-answer')
        return 'No answer from DryScope. Try again: it makes the same new draft.';
      return answer.message;
    });

  const discard = () =>
    run('Discarding…', async () => {
      await discardEntries(client!, problem.entries);
      return null;
    });

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-lg font-semibold">
        {words.title}
      </h3>
      <p id={textId} className="text-base">
        {words.text}
      </p>
      <p className="text-sm">
        {label}: {count === 1 ? '1 change' : `${count} changes`} on this phone.
      </p>
      {problem.saveAsNew ? (
        <>
          <Button disabled={busy !== null || !online} onClick={() => void saveAsNew()}>
            {SAVE_AS_NEW}
          </Button>
          <p className="text-sm">{PHOTOS_STAY}</p>
        </>
      ) : null}
      {problem.tryAgain ? (
        <Button variant="outline" disabled={busy !== null || !online} onClick={() => void again()}>
          Try again
        </Button>
      ) : null}
      {problem.reason === 'finished' && problem.jobId ? (
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
          {count === 1 ? 'The change' : `The ${count} changes`} to {label} will be removed from this phone.
          DryScope never had {count === 1 ? 'it' : 'them'}, so this cannot be undone.
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
