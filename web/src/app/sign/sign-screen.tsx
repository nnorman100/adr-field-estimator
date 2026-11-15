'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FocusedPanel } from '@/app/(auth)/focused-panel';
import { ItemizedClaim, PhotoLog, Proposal } from '@/app/(auth)/sign-in/[address]/jobs/[jobId]/review/review-documents';
import { clearPad, padPng, SignaturePad } from '@/app/(auth)/sign-in/[address]/jobs/[jobId]/review/signature-pad';
import { SignedAgreementView } from '@/app/(auth)/sign-in/[address]/jobs/[jobId]/review/signing';
import { ShareLink } from '@/components/links/share-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agreementAnswerOf, SIGNER_NAME_LIMIT, SIGNER_ROLE_NAMES, SIGNER_ROLES, type SignedAgreement, type SignerRole } from '@/lib/agreements/screen';
import { linkCall, linkImageAddress, type LinkAnswer } from '@/lib/links/client';
import {
  CONSENTS,
  fragmentToken,
  issuedLinksOf,
  linkAddress,
  pageOutcomeOf,
  SET_NAMES,
  signingPageOf,
  untilDay,
  watchFragment,
  type LinkEstimate,
  type PageNext,
} from '@/lib/links/screen';

// Review and sign your estimate (S5a-11b): the documents the technician's phone shows on site, with
// the company's start-work authorization and payment terms in the proposal and each photo on
// request, then the signer's name and role, two boxes, a signature and Sign. Once signed, the same
// signed page the company keeps, read from the agreement's stored bytes, for 30 days, with the links
// to the signed documents made at signing (shown once). Every request keeps its ids until the server
// answers, so "Try again" after a lost answer is the same request, never a second signature.

type Phase =
  | { name: 'checking' }
  | { name: 'refused'; message: string; next: PageNext }
  | { name: 'pending'; companyName: string; expiresAt: string; estimate: LinkEstimate }
  | { name: 'signed'; companyName: string; viewUntil: string; agreement: SignedAgreement; issued?: Issued[] };

type Issued = ReturnType<typeof issuedLinksOf>[number];

// The page for the link routes' answer.
function phaseOf(answer: LinkAnswer): Phase {
  const page = answer.status === 200 ? signingPageOf(answer.body) : null;
  if (!page) return { name: 'refused', ...pageOutcomeOf(answer.status, answer.body) };
  if (page.status === 'pending') return { name: 'pending', companyName: page.companyName, expiresAt: page.expiresAt, estimate: page.estimate };
  return { name: 'signed', companyName: page.companyName, viewUntil: page.viewUntil, agreement: page.agreement };
}

export function SignScreen() {
  // The token from the address's fragment; null on the server's render and when there is none.
  const token = useSyncExternalStore(watchFragment, fragmentToken, () => null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (token) return;
    // The fragment is read once the page is in the browser: wait a moment before saying none came.
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
  // A new token in the address is a new page: nothing shown, ticked or drawn for another link stays.
  return <SignPage key={token} token={token} />;
}

function Opening() {
  return (
    <FocusedPanel title="Your estimate">
      <p role="status">Opening the estimate…</p>
    </FocusedPanel>
  );
}

function SignPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });

  useEffect(() => {
    let gone = false;
    void linkCall(token, '/api/sign').then((answer) => {
      if (!gone) setPhase(phaseOf(answer));
    });
    return () => {
      gone = true;
    };
  }, [token]);

  const load = useCallback(async () => {
    setPhase({ name: 'checking' });
    setPhase(phaseOf(await linkCall(token, '/api/sign')));
  }, [token]);

  const loadSignature = useCallback(() => linkImageAddress(token, '/api/sign/signature'), [token]);
  const loadPhoto = useCallback((photoId: string) => linkImageAddress(token, `/api/sign/photos/${encodeURIComponent(photoId)}`), [token]);

  switch (phase.name) {
    case 'checking':
      return <Opening />;
    case 'refused':
      return (
        <FocusedPanel title="This link cannot be used">
          <p role="alert">{phase.message}</p>
          {phase.next === 'retry' || phase.next === 'reload' ? <Button onClick={() => void load()}>Try again</Button> : null}
        </FocusedPanel>
      );
    case 'signed':
      return (
        <FocusedPanel title="Your signed estimate">
          <p>
            Signed with {phase.companyName}. You can open this page until {untilDay(phase.viewUntil)}. Print or save a copy
            from your browser to keep one.
          </p>
          {phase.issued?.length ? (
            <section aria-labelledby="link-issued" className="flex flex-col gap-3 rounded-md border p-3">
              <h2 id="link-issued" className="text-lg font-semibold">
                Links to your signed documents
              </h2>
              <p className="text-sm">Each works for 30 days. Copy or share them now: they are shown only this once.</p>
              {phase.issued.map((shown) => (
                <ShareLink
                  key={shown.set}
                  address={linkAddress(window.location.origin, 'documents', shown.token)}
                  label={`${SET_NAMES[shown.set]} link`}
                  shareTitle="Your signed estimate documents"
                />
              ))}
            </section>
          ) : null}
          <SignedAgreementView agreement={phase.agreement} loadSignature={loadSignature} loadPhoto={loadPhoto} />
        </FocusedPanel>
      );
    case 'pending':
      return (
        <FocusedPanel title="Review and sign your estimate">
          <p>
            From {phase.companyName}. This link works until {untilDay(phase.expiresAt)}. Read the proposal and the documents below, then sign at the
            bottom.
          </p>
          <LinkDocuments estimate={phase.estimate} loadPhoto={loadPhoto} />
          <LinkSigning
            token={token}
            onSigned={(agreement, issued) => setPhase({ name: 'signed', companyName: phase.companyName, viewUntil: viewUntilOf(agreement), agreement, issued })}
            onRefused={(outcome) => setPhase({ name: 'refused', ...outcome })}
          />
        </FocusedPanel>
      );
  }
}

// The documents as the signed record will hold them: the proposal with its terms, then the itemized
// claim, the scope defense letter and the photo audit log.
function LinkDocuments({ estimate, loadPhoto }: { estimate: LinkEstimate; loadPhoto: (photoId: string) => Promise<string | null> }) {
  const end = estimate.proposal.price.low;
  return (
    <>
      <section aria-labelledby="link-proposal" className="flex flex-col gap-2">
        <h2 id="link-proposal" className="text-lg font-semibold">
          Proposal
        </h2>
        <div className="rounded-md border p-3">
          <Proposal proposal={estimate.proposal} />
        </div>
      </section>
      <section aria-labelledby="link-documents" className="flex flex-col gap-2">
        <h2 id="link-documents" className="text-lg font-semibold">
          Supporting documents
        </h2>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-semibold">Itemized claim</summary>
          <ItemizedClaim rows={estimate.documents.itemized_claim} end={end} afterHoursLabel={estimate.proposal.price.after_hours_label} />
        </details>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-semibold">Scope defense letter</summary>
          <p className="pt-3 break-words whitespace-pre-wrap">{estimate.documents.letter}</p>
        </details>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-semibold">Photo audit log</summary>
          <PhotoLog photos={estimate.documents.photo_log} loadPhoto={loadPhoto} />
        </details>
      </section>
    </>
  );
}

// A used link shows the signed record for 30 days after signing (the server's own rule).
const viewUntilOf = (agreement: SignedAgreement) => new Date(Date.parse(agreement.signedAt) + 30 * 86_400_000).toISOString();

type Attempt = { signatureId: string; agreementId: string; png: Uint8Array; name: string; role: SignerRole; uploaded: boolean };

function LinkSigning({
  token,
  onSigned,
  onRefused,
}: {
  token: string;
  onSigned: (agreement: SignedAgreement, issued: Issued[]) => void;
  onRefused: (outcome: { message: string; next: PageNext }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<SignerRole | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [electronic, setElectronic] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<{ message: string; next: PageNext } | null>(null);
  const nameMissing = name.trim() === '';

  function clear() {
    attempt.current = null;
    setLocked(false);
    setDrawn(false);
    setProblem(null);
    if (canvasRef.current) clearPad(canvasRef.current);
  }

  function refused(outcome: { message: string; next: PageNext }) {
    // A link that cannot sign any more replaces the page with its message.
    if (outcome.next === 'done') return onRefused(outcome);
    if (outcome.next === 'redraw') {
      attempt.current = null;
      setLocked(false);
    }
    setProblem(outcome);
  }

  async function sign() {
    setChecked(true);
    if (nameMissing || !role || !drawn || !reviewed || !electronic || busy) return;
    setBusy(true);
    setProblem(null);
    const signerName = name.trim();
    let sending = attempt.current;
    if (!sending) {
      const png = canvasRef.current ? await padPng(canvasRef.current) : null;
      if (!png) {
        setBusy(false);
        return setProblem({ message: 'The signature could not be read. Clear it, draw it again, then sign.', next: 'redraw' });
      }
      sending = { signatureId: crypto.randomUUID(), agreementId: crypto.randomUUID(), png, name: signerName, role, uploaded: false };
      setLocked(true);
    } else if (sending.name !== signerName || sending.role !== role) {
      sending = { ...sending, agreementId: crypto.randomUUID(), name: signerName, role };
    }
    attempt.current = sending;

    if (!sending.uploaded) {
      const receipt = await linkCall(token, `/api/sign/signature/${encodeURIComponent(sending.signatureId)}`, { method: 'PUT', bytes: sending.png, type: 'image/png' });
      if (receipt.status !== 200 && receipt.status !== 201) {
        setBusy(false);
        return refused(pageOutcomeOf(receipt.status, receipt.body));
      }
      sending = { ...sending, uploaded: true };
      attempt.current = sending;
    }
    const answer = await linkCall(token, '/api/sign', {
      method: 'POST',
      json: { id: sending.agreementId, signatureId: sending.signatureId, signerName, signerRole: sending.role, documentsConfirmed: true, electronicConsent: true },
    });
    setBusy(false);
    const signed = answer.status === 200 || answer.status === 201 ? agreementAnswerOf(answer.body)?.agreement : null;
    if (signed) return onSigned(signed, issuedLinksOf(answer.body));
    refused(pageOutcomeOf(answer.status === 200 || answer.status === 201 ? 0 : answer.status, answer.body));
  }

  return (
    <section aria-labelledby="link-signing-heading" className="flex flex-col gap-3">
      <h2 id="link-signing-heading" className="text-lg font-semibold">
        Sign
      </h2>
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 size-5 shrink-0" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} />
        <span>{CONSENTS.documents}</span>
      </label>
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 size-5 shrink-0" checked={electronic} disabled={busy} onChange={(event) => setElectronic(event.target.checked)} />
        <span>{CONSENTS.electronic}</span>
      </label>
      {checked && (!reviewed || !electronic) ? <p className="text-sm text-red-700">Tick both boxes to sign.</p> : null}
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Your full name</span>
        <Input
          value={name}
          maxLength={SIGNER_NAME_LIMIT}
          autoComplete="name"
          disabled={busy}
          aria-invalid={checked && nameMissing}
          aria-describedby={checked && nameMissing ? 'link-signer-name-missing' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {checked && nameMissing ? (
        <p id="link-signer-name-missing" className="text-sm text-red-700">
          Write your name.
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-2" aria-describedby={checked && !role ? 'link-signer-role-missing' : undefined}>
        <legend className="font-semibold">You are signing as</legend>
        {SIGNER_ROLES.map((value) => (
          <label key={value} className="flex items-center gap-3">
            <input type="radio" name="link-signer-role" className="size-5 shrink-0" value={value} checked={role === value} disabled={busy} onChange={() => setRole(value)} />
            <span>{SIGNER_ROLE_NAMES[value]}</span>
          </label>
        ))}
      </fieldset>
      {checked && !role ? (
        <p id="link-signer-role-missing" className="text-sm text-red-700">
          Choose who is signing.
        </p>
      ) : null}
      <p id="link-signature-pad-label" className="font-semibold">
        Signature
      </p>
      <p className="text-sm">Sign inside the box with a finger.</p>
      <SignaturePad canvasRef={canvasRef} locked={locked || busy} labelledBy="link-signature-pad-label" onDrawn={() => setDrawn(true)} onCleared={clear} />
      {checked && !drawn ? <p className="text-sm text-red-700">Draw your signature in the box.</p> : null}
      <Button variant="outline" disabled={busy} onClick={clear}>
        Clear the signature
      </Button>
      {problem ? (
        <div role="alert" className="flex flex-col gap-3 rounded-md border border-red-700 p-3">
          <p>{problem.message}</p>
          {problem.next === 'reload' ? (
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          ) : null}
        </div>
      ) : null}
      <p role="status" className="text-sm">
        {busy ? 'Signing…' : ''}
      </p>
      <Button disabled={busy || problem?.next === 'reload'} onClick={() => void sign()}>
        {problem?.next === 'retry' ? 'Try signing again' : 'Sign'}
      </Button>
    </section>
  );
}
