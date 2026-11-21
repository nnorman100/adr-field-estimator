'use client';

import type { User } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RepricePreview } from '@/lib/estimates/service';
import { repriceLines, repriceOutcomeOf, repricePreviewOf, screenOutOfDate } from '@/lib/estimates/reprice-screen';
import { callApi } from '@/lib/firebase-client';

// The owner's Reprice this draft banner (S5b-6, pricing plan S5b-1): shown on Review before signing
// only when newer prices are published than the ones the job is pinned to. The banner opens a dialog
// with the server's before/after preview; nothing is sent until the owner confirms in it, and Cancel
// (or Esc) sends nothing. The dialog shows one preview, taken when it was opened, and its Confirm
// sends exactly that preview's version and job revision; the action stays unavailable until a
// refusal's refreshed preview is in, so a dialog is never opened on a preview about to be replaced.
// A reprice voids the current estimate and its scope confirmation, and a job that was signed,
// changed or made unreachable elsewhere, or a sign-in the server no longer accepts, is no longer what
// this screen shows, so in those cases, after an answer to a reprice that was lost, and when the
// preview's job revision is not the one Review loaded, Review reads the job and its estimate again. The preview adds no rule of its own: when it cannot price, it says why and the
// action stays, and the server decides.
export const REPRICE_OPEN = 'Review and reprice';
export const REPRICE_TITLE = 'Reprice this draft?';
export const REPRICE_CONFIRM = 'Reprice this draft';

type Read = { name: 'loading' } | { name: 'unavailable' } | { name: 'ready'; preview: RepricePreview };
// The one dialog instance: what it shows and what its Confirm sends.
type Shown = { versionId: string; revision: number; pinnedPrice: string | null; lines: { before: string; after: string } };

export function RepriceBanner({ user, jobId, revision, onChanged }: { user: User; jobId: string; revision: number; onChanged: () => void }) {
  const [read, setRead] = useState<Read>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // One change id per confirmation basis, kept for a retry after a lost answer.
  const change = useRef<{ key: string; id: string } | null>(null);
  const path = `/api/jobs/${encodeURIComponent(jobId)}/reprice`;
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  });

  // The preview as it is now, or Review read again when it shows the screen is out of date.
  const load = useCallback(async (): Promise<Read> => {
    const answer = await callApi(user, path);
    if (screenOutOfDate(answer.status, answer.body)) {
      changed.current();
      return { name: 'loading' };
    }
    const preview = answer.status === 200 ? repricePreviewOf(answer.body) : null;
    if (!preview) return { name: 'unavailable' };
    if (preview.job.revision !== revision) {
      changed.current();
      return { name: 'loading' };
    }
    return { name: 'ready', preview };
  }, [user, path, revision]);

  useEffect(() => {
    let live = true;
    void load().then((next) => {
      if (live) setRead(next);
    });
    return () => {
      live = false;
    };
  }, [load]);

  useEffect(() => {
    if (shown && !dialog.current?.open) dialog.current?.showModal();
  }, [shown]);

  if (read.name === 'loading') return null;
  if (read.name === 'unavailable') {
    return (
      <p role="status" className="rounded-md border border-amber-700 p-3">
        Whether newer prices are published could not be checked. Reload to try again.
      </p>
    );
  }
  const { preview } = read;
  const reprice = preview.reprice;
  if (!reprice) return null;
  const open = () => {
    setProblem(null);
    setShown({ versionId: reprice.newest.versionId, revision: preview.job.revision, pinnedPrice: reprice.pinned.price, lines: repriceLines(reprice) });
  };

  async function confirm(basis: Shown) {
    const key = `${basis.versionId}/${basis.revision}`;
    if (change.current?.key !== key) change.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    const answer = await callApi(user, path, {
      method: 'POST',
      json: { revision: basis.revision, changeId: change.current.id, versionId: basis.versionId, pinnedPrice: basis.pinnedPrice },
    });
    // After a lost or failed answer the reprice may have been committed, so Review reads the job
    // again rather than keep an estimate that may be void.
    if (answer.status === 200 || answer.status === 0 || answer.status >= 500 || screenOutOfDate(answer.status, answer.body)) return changed.current();
    setProblem(repriceOutcomeOf(answer.body));
    // A refusal for a changed basis shows the preview as it is now.
    if (answer.status === 409) setRead(await load());
    setBusy(false);
  }

  return (
    <section aria-labelledby="reprice-heading" className="flex flex-col gap-2 rounded-md border border-amber-700 p-3">
      <h2 id="reprice-heading" className="text-lg font-semibold">
        Newer prices are published
      </h2>
      <p>This job is priced from prices version {reprice.pinned.version}. You can reprice it with your newest prices, version {reprice.newest.version}.</p>
      {problem ? (
        <p role="alert" className="text-sm">
          {problem}
        </p>
      ) : null}
      <p role="status" className="text-sm">
        {busy ? 'Repricing…' : ''}
      </p>
      <Button disabled={busy} onClick={open}>
        {REPRICE_OPEN}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="reprice-title"
        aria-describedby="reprice-text"
        onClose={(event) => {
          const value = event.currentTarget.returnValue;
          event.currentTarget.returnValue = '';
          const basis = shown;
          setShown(null);
          if (value === 'reprice' && basis) void confirm(basis);
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md overscroll-contain rounded-2xl border border-input bg-background p-6 text-foreground backdrop:overflow-hidden backdrop:overscroll-contain backdrop:bg-black/40"
      >
        <h2 id="reprice-title" className="text-xl font-semibold">
          {REPRICE_TITLE}
        </h2>
        <ul id="reprice-text" className="mt-3 list-disc pl-5">
          <li>{shown?.lines.before}</li>
          <li>{shown?.lines.after}</li>
        </ul>
        <p className="mt-3 text-sm">
          Repricing replaces this job&apos;s estimate. The scope must then be confirmed again: go back to editing, confirm it, then finish and review. The revised
          estimate needs a new signature.
        </p>
        <form method="dialog" className="mt-4 flex flex-col gap-2">
          <Button autoFocus variant="outline" value="">
            Cancel
          </Button>
          <Button value="reprice">{REPRICE_CONFIRM}</Button>
        </form>
      </dialog>
    </section>
  );
}
