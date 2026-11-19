'use client';

import type { User } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RepricePreview } from '@/lib/estimates/service';
import { repriceLines, repriceOutcomeOf, repricePreviewOf } from '@/lib/estimates/reprice-screen';
import { callApi } from '@/lib/firebase-client';

// The owner's Reprice this draft banner (S5b-6, pricing plan S5b-1): shown on Review before signing
// only when newer prices are published than the ones the job is pinned to. It reads the server's
// before/after preview and, on the owner's confirmation, sends that preview's version and the job
// revision it was read at. A reprice voids the current estimate and its scope confirmation, so the
// job is reloaded afterwards and goes through Back to editing and Finish again.
export function RepriceBanner({ user, jobId, onRepriced }: { user: User; jobId: string; onRepriced: () => void }) {
  const [preview, setPreview] = useState<RepricePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One change id per confirmation basis, kept for a retry after a lost answer.
  const change = useRef<{ key: string; id: string } | null>(null);
  const path = `/api/jobs/${encodeURIComponent(jobId)}/reprice`;

  const read = useCallback(async () => {
    const answer = await callApi(user, path);
    setPreview(answer.status === 200 ? repricePreviewOf(answer.body) : null);
  }, [user, path]);

  useEffect(() => {
    let live = true;
    void callApi(user, path).then((answer) => {
      if (live) setPreview(answer.status === 200 ? repricePreviewOf(answer.body) : null);
    });
    return () => {
      live = false;
    };
  }, [user, path]);

  const reprice = preview?.reprice;
  if (!preview || !reprice) return null;
  const lines = repriceLines(reprice);

  async function confirm() {
    if (!preview?.reprice) return;
    const key = `${preview.reprice.newest.versionId}/${preview.job.revision}`;
    if (change.current?.key !== key) change.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setProblem(null);
    const answer = await callApi(user, path, {
      method: 'POST',
      json: {
        revision: preview.job.revision,
        changeId: change.current.id,
        versionId: preview.reprice.newest.versionId,
      },
    });
    setBusy(false);
    if (answer.status === 200) return onRepriced();
    setProblem(repriceOutcomeOf(answer.status, answer.body));
    // A refusal for a changed basis shows the preview as it is now.
    if (answer.status === 409) await read();
  }

  return (
    <section aria-labelledby="reprice-heading" className="flex flex-col gap-2 rounded-md border border-amber-700 p-3">
      <h2 id="reprice-heading" className="text-lg font-semibold">
        Newer prices are published
      </h2>
      <p>This job keeps the prices it was first priced with. You can reprice it with your newest prices.</p>
      <ul className="list-disc pl-5">
        <li>{lines.before}</li>
        <li>{lines.after}</li>
      </ul>
      <p className="text-sm">
        Repricing replaces this job&apos;s estimate. The scope must then be confirmed again: go back to editing, confirm it, then finish and review. The revised
        estimate needs a new signature.
      </p>
      {problem ? (
        <p role="alert" className="text-sm">
          {problem}
        </p>
      ) : null}
      <p role="status" className="text-sm">
        {busy ? 'Repricing…' : ''}
      </p>
      {reprice.newest.refused ? null : (
        <Button disabled={busy} onClick={() => void confirm()}>
          Reprice this draft
        </Button>
      )}
    </section>
  );
}
