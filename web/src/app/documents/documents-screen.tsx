'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { FocusedPanel } from '@/app/(auth)/focused-panel';
import { ItemizedClaim, PhotoLog, Proposal } from '@/app/(auth)/sign-in/[address]/jobs/[jobId]/review/review-documents';
import { Button } from '@/components/ui/button';
import { signedWhen } from '@/lib/agreements/screen';
import { linkCall, linkImageAddress, type LinkAnswer } from '@/lib/links/client';
import { documentsPageOf, fragmentToken, pageOutcomeOf, untilDay, watchFragment, type DocumentsPage, type PageNext } from '@/lib/links/screen';

// Your signed estimate documents (S5a-11b): one set of a signed estimate, read-only, from the signed
// record's stored bytes. The homeowner's set is the signed proposal (with the company's terms, the
// signature, who signed, when and how) and the photo log; the adjuster's is the itemized claim, the
// scope defense letter and the claim.

type Phase = { name: 'checking' } | { name: 'refused'; message: string; next: PageNext } | { name: 'ready'; page: DocumentsPage };

function phaseOf(answer: LinkAnswer): Phase {
  const page = answer.status === 200 ? documentsPageOf(answer.body) : null;
  return page ? { name: 'ready', page } : { name: 'refused', ...pageOutcomeOf(answer.status, answer.body) };
}

export function DocumentsScreen() {
  const token = useSyncExternalStore(watchFragment, fragmentToken, () => null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (token) return;
    const later = setTimeout(() => setMissing(true), 50);
    return () => clearTimeout(later);
  }, [token]);

  if (!token) {
    return missing ? (
      <FocusedPanel title="This link cannot be used">
        <p role="alert">{pageOutcomeOf(404, { error: 'link_unavailable' }).message}</p>
      </FocusedPanel>
    ) : (
      <Opening />
    );
  }
  // A new token in the address is a new page: no document of another link stays on screen.
  return <LinkDocumentsPage key={token} token={token} />;
}

function Opening() {
  return (
    <FocusedPanel title="Signed estimate documents">
      <p role="status">Opening the documents…</p>
    </FocusedPanel>
  );
}

function LinkDocumentsPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });

  useEffect(() => {
    let gone = false;
    void linkCall(token, '/api/documents').then((answer) => {
      if (!gone) setPhase(phaseOf(answer));
    });
    return () => {
      gone = true;
    };
  }, [token]);

  const load = useCallback(async () => {
    setPhase({ name: 'checking' });
    setPhase(phaseOf(await linkCall(token, '/api/documents')));
  }, [token]);

  if (phase.name === 'checking') return <Opening />;
  if (phase.name === 'refused') {
    return (
      <FocusedPanel title="This link cannot be used">
        <p role="alert">{phase.message}</p>
        {phase.next === 'retry' || phase.next === 'reload' ? <Button onClick={() => void load()}>Try again</Button> : null}
      </FocusedPanel>
    );
  }
  const { page } = phase;
  return (
    <FocusedPanel title="Signed estimate documents">
      <p>
        From {page.companyName}. Signed by {page.signed.name}, {signedWhen(page.signed.signedAt)}. This link works until {untilDay(page.expiresAt)}; print
        or save a copy from your browser to keep one.
      </p>
      {page.set === 'homeowner' ? <HomeownerSet page={page} token={token} /> : null}
      {page.set === 'adjuster' ? <AdjusterSet page={page} /> : null}
    </FocusedPanel>
  );
}

function HomeownerSet({ page, token }: { page: Extract<DocumentsPage, { set: 'homeowner' }>; token: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let address: string | null = null;
    let gone = false;
    void linkImageAddress(token, '/api/documents/signature').then((made) => {
      if (gone) {
        if (made) URL.revokeObjectURL(made);
        return;
      }
      address = made;
      setImage(made);
    });
    return () => {
      gone = true;
      if (address) URL.revokeObjectURL(address);
    };
  }, [token]);
  return (
    <>
      <section aria-labelledby="documents-proposal" className="flex flex-col gap-2">
        <h2 id="documents-proposal" className="text-lg font-semibold">
          Signed proposal
        </h2>
        <div className="rounded-md border p-3">
          <Proposal proposal={page.proposal} />
        </div>
      </section>
      <section aria-labelledby="documents-signed" className="flex flex-col gap-2 rounded-md border border-green-800 p-3">
        <h2 id="documents-signed" className="text-lg font-semibold">
          Signed record
        </h2>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob address of the stored signature bytes
          <img src={image} alt={`Signature of ${page.signed.name}`} className="h-28 w-full rounded-md border bg-white object-contain" />
        ) : (
          <p className="text-sm">The signature image is not loaded. It is kept with the signed record.</p>
        )}
        <p>Signed by {page.signed.name}</p>
        <p>{signedWhen(page.signed.signedAt)}</p>
        <p>{page.signed.how}</p>
        <p className="text-sm break-all">Proposal SHA-256 {page.proposalSha256}</p>
      </section>
      <section aria-labelledby="documents-photos" className="flex flex-col gap-2">
        <h2 id="documents-photos" className="text-lg font-semibold">
          Photo audit log
        </h2>
        <PhotoLog photos={page.photoLog} />
      </section>
    </>
  );
}

function AdjusterSet({ page }: { page: Extract<DocumentsPage, { set: 'adjuster' }> }) {
  return (
    <>
      <section aria-labelledby="documents-claim" className="flex flex-col gap-2">
        <h2 id="documents-claim" className="text-lg font-semibold">
          Itemized claim
        </h2>
        <ItemizedClaim rows={page.itemizedClaim} end={page.price.low} afterHoursLabel={page.price.after_hours_label} />
      </section>
      <section aria-labelledby="documents-letter" className="flex flex-col gap-2">
        <h2 id="documents-letter" className="text-lg font-semibold">
          Scope defense letter
        </h2>
        <p className="break-words whitespace-pre-wrap">{page.letter}</p>
      </section>
      <section aria-labelledby="documents-claim-details" className="flex flex-col gap-2">
        <h2 id="documents-claim-details" className="text-lg font-semibold">
          Claim
        </h2>
        <pre className="overflow-x-auto rounded-md border p-3 text-sm whitespace-pre-wrap break-words">{JSON.stringify(page.claim, null, 2)}</pre>
      </section>
    </>
  );
}
