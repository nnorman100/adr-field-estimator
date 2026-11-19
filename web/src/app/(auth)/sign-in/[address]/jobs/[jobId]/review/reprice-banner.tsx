'use client';

import type { User } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RepricePreview } from '@/lib/estimates/service';
import { repriceLines, repriceOutcomeOf, repricePreviewOf } from '@/lib/estimates/reprice-screen';
import { callApi } from '@/lib/firebase-client';

// The owner's Reprice this draft banner (S5b-6, pricing plan S5b-1): shown on Review before signing
// only when newer prices are published than the ones the job is pinned to. The banner opens a dialog
// with the server's before/after preview; nothing is sent until the owner confirms in it, and Cancel
// (or Esc) sends nothing. The confirmation sends the preview's version and the job revision it was
// read at. A reprice voids the current estimate and its scope confirmation, and a job that changed
// under the preview is no longer what this screen shows, so in both cases the job and its estimate
// are read again. The preview adds no rule of its own: when it cannot price, it says why and the
// action stays, and the server decides.
export const REPRICE_OPEN = 'Review and reprice';
export const REPRICE_TITLE = 'Reprice this draft?';
export const REPRICE_CONFIRM = 'Reprice this draft';

type Read = { name: 'loading' } | { name: 'unavailable' } | { name: 'ready'; preview: RepricePreview };

export function RepriceBanner({ user, jobId, onChanged }: { user: User; jobId: string; onChanged: () => void }) {
  const [read, setRead] = useState<Read>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // One change id per confirmation basis, kept for a retry after a lost answer.
  const change = useRef<{ key: string; id: string } | null>(null);
  const path = `/api/jobs/${encodeURIComponent(jobId)}/reprice`;

  const load = useCallback(async (): Promise<Read> => {
    const answer = await callApi(user, path);
    const preview = answer.status === 200 ? repricePreviewOf(answer.body) : null;
    return preview ? { name: 'ready', preview } : { name: 'unavailable' };
  }, [user, path]);

  useEffect(() => {
    let live = true;
    void load().then((next) => {
      if (live) setRead(next);
    });
    return () => {
      live = false;
    };
  }, [load]);

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
  const lines = repriceLines(reprice);

  async function confirm(basis: { versionId: string; revision: number }) {
    const key = `${basis.versionId}/${basis.revision}`;
    if (change.current?.key !== key) change.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setProblem(null);
    const answer = await callApi(user, path, {
      method: 'POST',
      json: { revision: basis.revision, changeId: change.current.id, versionId: basis.versionId },
    });
    setBusy(false);
    if (answer.status === 200) return onChanged();
    const code = answer.body !== null && typeof answer.body === 'object' ? (answer.body as { error?: unknown }).error : undefined;
    // The job moved on since it was opened (another device repriced, or it was edited): what this
    // screen shows is out of date, so the job and its estimate are read again.
    if (code === 'stale_revision') return onChanged();
    setProblem(repriceOutcomeOf(answer.status, answer.body));
    // A refusal for a changed basis shows the preview as it is now.
    if (answer.status === 409) setRead(await load());
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
      <Button disabled={busy} onClick={() => dialog.current?.showModal()}>
        {REPRICE_OPEN}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="reprice-title"
        aria-describedby="reprice-text"
        onClose={(event) => {
          const value = event.currentTarget.returnValue;
          event.currentTarget.returnValue = '';
          if (value === 'reprice') void confirm({ versionId: reprice.newest.versionId, revision: preview.job.revision });
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md overscroll-contain rounded-2xl border border-input bg-background p-6 text-foreground backdrop:overflow-hidden backdrop:overscroll-contain backdrop:bg-black/40"
      >
        <h2 id="reprice-title" className="text-xl font-semibold">
          {REPRICE_TITLE}
        </h2>
        <ul id="reprice-text" className="mt-3 list-disc pl-5">
          <li>{lines.before}</li>
          <li>{lines.after}</li>
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
