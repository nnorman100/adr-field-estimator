'use client';

import type { User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { aiUsageView, formatMicroUsd, usedOf, type AiUsageView } from '@/lib/ai/usage-screen';
import { callApi } from '@/lib/firebase-client';

// "AI used today / this month" on the owner's Company settings (S7-4): what the company's AI help
// has cost against its daily and monthly AI ceilings, from GET /api/companies/{id}/ai-usage. These
// are Google's charges for AI help, never a price of the company's work. The screen only shows this
// for a role holding ai_usage_read (the owner); the server refuses everyone else again.
export function AiUsageSection({ user, companyId }: { user: User; companyId: string }) {
  const [state, setState] = useState<{ name: 'loading' } | { name: 'unavailable' } | { name: 'ready'; usage: AiUsageView }>({
    name: 'loading',
  });

  useEffect(() => {
    let current = true;
    void callApi(user, `/api/companies/${companyId}/ai-usage`).then((answer) => {
      if (!current) return;
      const usage = answer.status === 200 ? aiUsageView(answer.body) : null;
      setState(usage ? { name: 'ready', usage } : { name: 'unavailable' });
    });
    return () => {
      current = false;
    };
  }, [user, companyId]);

  const held = state.name === 'ready' ? Math.max(state.usage.today.heldMicroUsd, state.usage.thisMonth.heldMicroUsd) : 0;

  return (
    <section aria-labelledby="ai-usage-heading" className="flex flex-col gap-2 rounded-md border border-foreground/40 p-3">
      <h2 id="ai-usage-heading" className="font-semibold">
        AI use
      </h2>
      {state.name === 'loading' && <p>Loading the AI use…</p>}
      {state.name === 'unavailable' && <p>We could not load the AI use. Check your connection, then reload the page.</p>}
      {state.name === 'ready' && (
        <>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
            <dt>AI used today</dt>
            <dd className="text-right font-medium tabular-nums">{usedOf(state.usage.today)}</dd>
            <dt>AI used this month</dt>
            <dd className="text-right font-medium tabular-nums">{usedOf(state.usage.thisMonth)}</dd>
          </dl>
          {held > 0 && <p className="text-sm">Includes {formatMicroUsd(held)} set aside for AI requests not settled yet.</p>}
          <p className="text-sm">
            What your company&rsquo;s AI help has cost, not the prices of your work. The daily amount starts again at
            midnight UTC and the monthly amount on the 1st. If an amount runs out, AI help pauses; field work and
            estimates carry on.
          </p>
        </>
      )}
    </section>
  );
}
