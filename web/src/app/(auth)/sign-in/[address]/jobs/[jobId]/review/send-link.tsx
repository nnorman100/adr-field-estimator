'use client';

import type { User } from 'firebase/auth';
import { useEffect, useRef, useState } from 'react';
import { ShareLink } from '@/components/links/share-link';
import { Button } from '@/components/ui/button';
import { signOutcomeOf } from '@/lib/agreements/screen';
import type { EstimateView } from '@/lib/estimates/result';
import { callApi } from '@/lib/firebase-client';
import { linkAddress, signingLinkLine, signingLinkOf, type SigningLinkView } from '@/lib/links/screen';

// Send to the homeowner (S5a-11b): a signing link for this estimate, so the customer can review and
// sign on their own phone. The technician sends it from their own phone (copy, share sheet or QR);
// DryScope sends no email or text message (J7). The token is shown once, here, and kept only in this
// page's memory: reloading shows the link's state, never the token. Making a new link revokes the
// older one; a new estimate or a new submission voids it. A lost answer is retried with the same link
// id, which answers a new token and stops the unseen one.

const LINK_OUTCOMES: Record<string, string> = {
  already_signed: 'This job is already signed.',
  link_ended: 'That link has ended. Make a new one.',
  conflict: 'That link was already made with other details. Make a new one.',
};

export function SendLink({ user, jobId, estimate }: { user: User; jobId: string; estimate: EstimateView }) {
  const [link, setLink] = useState<SigningLinkView | null>(null);
  const [shown, setShown] = useState<{ id: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The id of a create whose answer has not come back yet: a retry sends the same one.
  const pending = useRef<string | null>(null);
  const path = `/api/jobs/${encodeURIComponent(jobId)}/signing-link`;

  useEffect(() => {
    let gone = false;
    void callApi(user, path).then((answer) => {
      if (!gone && answer.status === 200) setLink(signingLinkOf(answer.body));
    });
    return () => {
      gone = true;
    };
  }, [user, path]);

  async function make() {
    setBusy(true);
    setProblem(null);
    setShown(null);
    pending.current ??= crypto.randomUUID();
    const answer = await callApi(user, path, { method: 'POST', json: { id: pending.current, estimateId: estimate.id, proposalSha256: estimate.proposalSha256 } });
    setBusy(false);
    const made = answer.status === 200 || answer.status === 201 ? signingLinkOf(answer.body) : null;
    const body = answer.body as { token?: unknown; error?: unknown } | null;
    if (made && typeof body?.token === 'string') {
      pending.current = null;
      setLink(made);
      return setShown({ id: made.id, token: body.token });
    }
    if (answer.status !== 0 && answer.status < 500) pending.current = null;
    const code = typeof body?.error === 'string' ? body.error : '';
    setProblem(LINK_OUTCOMES[code] ?? signOutcomeOf(answer.status, answer.body).message);
  }

  async function revoke() {
    setBusy(true);
    setProblem(null);
    setShown(null);
    const answer = await callApi(user, path, { method: 'DELETE' });
    setBusy(false);
    if (answer.status === 200) return setLink(signingLinkOf(answer.body));
    setProblem(signOutcomeOf(answer.status, answer.body).message);
  }

  const out = link?.status === 'pending';
  return (
    <section aria-labelledby="send-link-heading" className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id="send-link-heading" className="text-lg font-semibold">
        Send to the homeowner
      </h2>
      <p className="text-sm">
        Not signing here? Send the customer a signing link. They see these same documents, with your company&apos;s authorization and payment terms,
        and sign on their own phone within 7 days. Making the link needs a connection.
      </p>
      <p role="status" className="text-sm">
        {busy ? 'Working…' : signingLinkLine(link)}
      </p>
      {problem ? (
        <p role="alert" className="rounded-md border border-red-700 p-3">
          {problem}
        </p>
      ) : null}
      {shown ? <ShareLink address={linkAddress(window.location.origin, 'sign', shown.token)} label="Signing link" shareTitle="Review and sign your estimate" /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant={shown ? 'outline' : 'default'} disabled={busy} onClick={() => void make()}>
          {out ? 'Make a new signing link' : 'Make a signing link'}
        </Button>
        {out ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void revoke()}>
            Revoke the link
          </Button>
        ) : null}
      </div>
      {out ? <p className="text-sm">A new link stops the one already sent.</p> : null}
    </section>
  );
}
