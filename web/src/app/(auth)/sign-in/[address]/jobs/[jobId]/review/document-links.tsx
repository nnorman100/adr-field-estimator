'use client';

import type { User } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShareLink } from '@/components/links/share-link';
import { Button } from '@/components/ui/button';
import { signOutcomeOf } from '@/lib/agreements/screen';
import { callApi } from '@/lib/firebase-client';
import { documentLinkLine, documentLinksOf, linkAddress, SET_NAMES, type DocumentLinkView } from '@/lib/links/screen';

// Share the signed documents (S5a-11b): a read-only link to the homeowner's set (the signed proposal
// and the photo log) or the adjuster's (the itemized claim, the scope defense letter and the claim),
// for 30 days. Whoever may sign makes one and sends it from their own phone; the owner or office may
// revoke one. A newer link for a set stops the older one. The token is shown once, here.

type Set = keyof typeof SET_NAMES;

export function DocumentLinks({ user, jobId, canSend, canRevoke }: { user: User; jobId: string; canSend: boolean; canRevoke: boolean }) {
  const [links, setLinks] = useState<DocumentLinkView[]>([]);
  const [made, setMade] = useState<{ set: Set; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = useRef<{ set: Set; id: string } | null>(null);
  const path = `/api/jobs/${encodeURIComponent(jobId)}/document-links`;

  const reload = useCallback(
    () =>
      callApi(user, path).then((answer) => {
        if (answer.status === 200) setLinks(documentLinksOf(answer.body) ?? []);
      }),
    [user, path],
  );

  useEffect(() => {
    let gone = false;
    void callApi(user, path).then((answer) => {
      if (!gone && answer.status === 200) setLinks(documentLinksOf(answer.body) ?? []);
    });
    return () => {
      gone = true;
    };
  }, [user, path]);

  async function make(set: Set) {
    setBusy(true);
    setProblem(null);
    if (pending.current?.set !== set) pending.current = { set, id: crypto.randomUUID() };
    const answer = await callApi(user, path, { method: 'POST', json: { id: pending.current.id, set } });
    setBusy(false);
    const body = answer.body as { token?: unknown } | null;
    if ((answer.status === 200 || answer.status === 201) && typeof body?.token === 'string') {
      pending.current = null;
      setMade({ set, token: body.token });
      return void reload();
    }
    if (answer.status !== 0 && answer.status < 500) pending.current = null;
    setProblem(signOutcomeOf(answer.status, answer.body).message);
  }

  async function revoke(id: string) {
    setBusy(true);
    setProblem(null);
    const answer = await callApi(user, `${path}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setBusy(false);
    if (answer.status !== 200) return setProblem(signOutcomeOf(answer.status, answer.body).message);
    void reload();
  }

  // Office and others who cannot make links see the section only once there are links to show.
  if (!canSend && links.length === 0) return null;
  return (
    <section aria-labelledby="document-links-heading" className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id="document-links-heading" className="text-lg font-semibold">
        Share the signed documents
      </h2>
      <p className="text-sm">A read-only link for 30 days: the homeowner&apos;s documents (the signed proposal and photo log) or the adjuster&apos;s (itemized claim, scope defense letter and claim).</p>
      <p role="status" className="text-sm">
        {busy ? 'Working…' : ''}
      </p>
      {problem ? (
        <p role="alert" className="rounded-md border border-red-700 p-3">
          {problem}
        </p>
      ) : null}
      {made ? <ShareLink address={linkAddress(window.location.origin, 'documents', made.token)} label={`${SET_NAMES[made.set]} link`} shareTitle="Your signed estimate documents" /> : null}
      {canSend ? (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SET_NAMES) as Set[]).map((set) => (
            <Button key={set} type="button" variant="outline" disabled={busy} onClick={() => void make(set)}>
              Make a link: {SET_NAMES[set]}
            </Button>
          ))}
        </div>
      ) : null}
      {links.length ? (
        <ul className="flex flex-col gap-2">
          {links.map((link) => (
            <li key={link.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">{documentLinkLine(link)}</span>
              {canRevoke && link.status === 'active' ? (
                <Button type="button" variant="outline" disabled={busy} onClick={() => void revoke(link.id)}>
                  Revoke the {SET_NAMES[link.set].toLowerCase()} link
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
