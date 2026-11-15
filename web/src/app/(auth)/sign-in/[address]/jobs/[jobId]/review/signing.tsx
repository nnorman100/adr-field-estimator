'use client';

import type { User } from 'firebase/auth';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sendSignature } from '@/lib/agreements/client';
import { agreementAnswerOf, signedHow, signedWhen, signOutcomeOf, SIGNER_NAME_LIMIT, type SignedAgreement, type SignNext } from '@/lib/agreements/screen';
import type { EstimateView } from '@/lib/estimates/result';
import { callApi } from '@/lib/firebase-client';
import { ItemizedClaim, PhotoLog, Proposal } from './review-documents';
import { clearPad, padPng, SignaturePad } from './signature-pad';

// Sign on the phone (S5a-11): the customer writes their name and draws their signature on the
// technician's phone. The signature image is sent through the photo route (?kind=signature), then
// the agreement; success shows only after the server's answer, and the signed page is then read
// from the agreement's stored bytes. Both requests carry ids made here and kept until the server
// answers, so "Try again" after a lost answer is the same request, never a second signature.
// "Email me a copy" is not offered: email arrives in S9 (J7).

type Attempt = { signatureId: string; agreementId: string; png: Uint8Array; name: string };

export function SigningForm({ user, jobId, estimate, onSigned }: { user: User; jobId: string; estimate: EstimateView; onSigned: (agreement: SignedAgreement) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState(false);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<{ message: string; next: SignNext } | null>(null);

  const nameMissing = name.trim() === '';

  // A refusal that the same request would only meet again: the next Sign makes new ids (from the
  // drawing as it is then), so it is a new request rather than a repeat of the refused one.
  function refused(outcome: { message: string; next: SignNext }) {
    if (outcome.next === 'redraw') {
      attempt.current = null;
      setLocked(false);
    }
    setProblem(outcome);
  }

  function clear() {
    attempt.current = null;
    setLocked(false);
    setDrawn(false);
    setProblem(null);
    if (canvasRef.current) clearPad(canvasRef.current);
  }

  async function sign() {
    setChecked(true);
    if (nameMissing || !drawn || busy) return;
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
      sending = { signatureId: crypto.randomUUID(), agreementId: crypto.randomUUID(), png, name: signerName };
      // From here the drawing is kept as sent: a retry sends the same bytes under the same id.
      setLocked(true);
    } else if (sending.name !== signerName) {
      // A corrected name is a new agreement request; the signature already sent stays the same.
      sending = { ...sending, agreementId: crypto.randomUUID(), name: signerName };
    }
    attempt.current = sending;

    const receipt = await sendSignature(user, jobId, sending.signatureId, sending.png);
    if (receipt.status !== 200 && receipt.status !== 201) {
      setBusy(false);
      return refused(signOutcomeOf(receipt.status, receipt.body));
    }
    const answer = await callApi(user, `/api/jobs/${encodeURIComponent(jobId)}/agreements`, {
      method: 'POST',
      json: {
        id: sending.agreementId,
        estimateId: estimate.id,
        proposalSha256: estimate.proposalSha256,
        signatureId: sending.signatureId,
        signerName,
        documentsConfirmed: true,
      },
    });
    setBusy(false);
    const signed = answer.status === 200 || answer.status === 201 ? agreementAnswerOf(answer.body)?.agreement : null;
    if (signed) return onSigned(signed);
    refused(answer.status === 200 || answer.status === 201 ? signOutcomeOf(0, null) : signOutcomeOf(answer.status, answer.body));
  }

  return (
    <section aria-labelledby="signing-heading" className="flex flex-col gap-3">
      <h2 id="signing-heading" className="text-lg font-semibold">
        Customer signature
      </h2>
      <p className="text-sm">
        The customer signs the proposal above, with its start-work authorization and payment terms. Signing needs a connection.
      </p>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Customer&apos;s full name</span>
        <Input
          value={name}
          maxLength={SIGNER_NAME_LIMIT}
          autoComplete="off"
          disabled={busy}
          aria-invalid={checked && nameMissing}
          aria-describedby={checked && nameMissing ? 'signer-name-missing' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {checked && nameMissing ? (
        <p id="signer-name-missing" className="text-sm text-red-700">
          Write the customer&apos;s name.
        </p>
      ) : null}
      <p id="signature-pad-label" className="font-semibold">
        Signature
      </p>
      <p className="text-sm">Sign inside the box with a finger.</p>
      <SignaturePad canvasRef={canvasRef} locked={locked || busy} labelledBy="signature-pad-label" onDrawn={() => setDrawn(true)} onCleared={clear} />
      {checked && !drawn ? <p className="text-sm text-red-700">Draw the signature in the box.</p> : null}
      <Button variant="outline" disabled={busy} onClick={clear}>
        Clear the signature
      </Button>
      {problem ? (
        <div role="alert" className="flex flex-col gap-3 rounded-md border border-red-700 p-3">
          <p>{problem.message}</p>
          {problem.next === 'reload' ? (
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload the job
            </Button>
          ) : null}
        </div>
      ) : null}
      <p role="status" className="text-sm">
        {busy ? 'Signing…' : ''}
      </p>
      <Button disabled={busy || problem?.next === 'done' || problem?.next === 'reload'} onClick={() => void sign()}>
        {problem?.next === 'retry' ? 'Try signing again' : 'Sign'}
      </Button>
    </section>
  );
}

// The signed page: the proposal with its terms, then the signature, who signed, when (the server's
// clock) and how, then the other documents, all from the agreement's stored bytes. Nothing on it can be changed here.
// `loadSignature` reads the stored signature image (the technician's photo route, or a link's own).
export function SignedAgreementView({ agreement, loadSignature }: { agreement: SignedAgreement; loadSignature: () => Promise<string | null> }) {
  const { record } = agreement;
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    let address: string | null = null;
    let gone = false;
    void loadSignature().then((made) => {
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
  }, [loadSignature]);

  const end = record.proposal.price.low;
  return (
    <>
      <section aria-labelledby="signed-proposal" className="flex flex-col gap-2">
        <h2 id="signed-proposal" className="text-lg font-semibold">
          Signed proposal
        </h2>
        <div className="rounded-md border p-3">
          <Proposal proposal={record.proposal} />
        </div>
      </section>
      <section aria-labelledby="signed-heading" className="flex flex-col gap-2 rounded-md border border-green-800 p-3">
        <h2 id="signed-heading" className="text-lg font-semibold">
          Signed record
        </h2>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob address of the stored signature bytes
          <img src={image} alt={`Signature of ${record.signer.name}`} className="h-28 w-full rounded-md border bg-white object-contain" />
        ) : (
          <p className="text-sm">The signature image is not loaded. It is kept with the signed record.</p>
        )}
        <p data-testid="signed-by">Signed by {record.signer.name}</p>
        <p data-testid="signed-when">{signedWhen(record.signed_at)}</p>
        <p data-testid="signed-how">{signedHow(record)}</p>
        <p className="text-sm break-all">Proposal SHA-256 {record.proposal_sha256}</p>
        <p className="text-sm">This record cannot change. A change to the work is a revised estimate the customer signs again.</p>
      </section>
      <section aria-labelledby="signed-documents" className="flex flex-col gap-2">
        <h2 id="signed-documents" className="text-lg font-semibold">
          Signed supporting documents
        </h2>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-semibold">Itemized claim</summary>
          <ItemizedClaim rows={record.documents.itemized_claim} end={end} afterHoursLabel={record.proposal.price.after_hours_label} />
        </details>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-semibold">Scope defense letter</summary>
          <p className="pt-3 break-words whitespace-pre-wrap">{record.documents.letter}</p>
        </details>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-semibold">Photo audit log</summary>
          <PhotoLog photos={record.documents.photo_log} />
        </details>
      </section>
    </>
  );
}
