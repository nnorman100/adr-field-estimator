'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { signatureAddress } from '@/lib/agreements/client';
import { agreementAnswerOf, type SignedAgreement } from '@/lib/agreements/screen';
import type { BrowserSignInConfig } from '@/lib/config';
import { canRepriceOf } from '@/lib/estimates/reprice-screen';
import type { EstimateView } from '@/lib/estimates/result';
import { notReadyReasons, outcomeOf, reviewAnswerOf, reviewerOf, revisionOf, type Next, type ReviewJob, type Reviewer } from '@/lib/estimates/screen';
import { signInOf, signOutOnRefusal, signOutOrShow, type FailedSignOut } from '@/lib/field/sign-out';
import { belongsTo, callApi, companyAuth } from '@/lib/firebase-client';
import { linkRightsOf, type DocumentLinkView } from '@/lib/links/screen';
import { endsSession, meOutcome } from '@/lib/sign-in/outcome';
import { FocusedPanel } from '../../../../../focused-panel';
import { Panel } from '../../../../../panel';
import { WorkNotSecured } from '../../../work-not-secured';
import { EstimateDocuments, EstimatePrice, StaffNotes } from './review-documents';
import { DocumentLinks } from './document-links';
import { RepriceBanner } from './reprice-banner';
import { SendLink } from './send-link';
import { SignedAgreementView, SigningForm, type IssuedLink } from './signing';

export type ReviewScreenProps = {
  address: string;
  companyName: string;
  tenantId: string;
  jobId: string;
  // null when sign-in is not set up for this environment yet.
  config: BrowserSignInConfig | null;
};

type Ready = {
  user: User;
  reviewer: Reviewer;
  // Who may send links (S5a-11b): `sign` makes them, `delivery_resend` revokes document links.
  links: { canSend: boolean; canRevoke: boolean };
  // The owner's Reprice this draft (S5b-6, `job_reprice`).
  canReprice: boolean;
  job: ReviewJob;
  // The job's revision as this screen read it; the Reprice banner checks its preview against it.
  revision: number;
  estimate: EstimateView | null;
  agreement: SignedAgreement | null;
};

type Phase =
  | { name: 'checking' }
  | { name: 'signed-out' }
  | { name: 'finish-sign-in' }
  | FailedSignOut
  | { name: 'not-found' }
  | { name: 'prices-off' }
  | ({ name: 'ready' } & Ready);

export function ReviewScreen(props: ReviewScreenProps) {
  if (!props.config) {
    return (
      <Panel title="Review before signing">
        <p>Sign-in is not set up here yet. Try again later.</p>
      </Panel>
    );
  }
  return <Review key={`${props.tenantId}/${props.jobId}`} {...props} config={props.config} />;
}

function Review({ address, companyName, tenantId, jobId, config }: ReviewScreenProps & { config: BrowserSignInConfig }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const authRef = useRef<Auth | null>(null);

  // Reads who is signed in, then the job and its current estimate, from the server.
  const load = useCallback(
    async (user: User) => {
      const stale = () => authRef.current?.currentUser !== user;
      setPhase({ name: 'checking' });
      // The sign-in this check is for, kept as the request goes.
      const auth = authRef.current!;
      const from = signInOf(user);
      const me = await callApi(user, '/api/me');
      if (stale()) return;
      const outcome = meOutcome(me.status, me.body);
      if (endsSession(outcome)) {
        await signOutOrShow(() => signOutOnRefusal(auth, tenantId, config, outcome.kind, true, from), setPhase);
        return;
      }
      if (outcome.kind === 'unavailable') return setPhase({ name: 'unavailable' });
      if (outcome.kind !== 'signed-in') return setPhase({ name: 'finish-sign-in' });
      const reviewer = reviewerOf(me.body);
      if (!reviewer) return setPhase({ name: 'unavailable' });
      const path = `/api/jobs/${encodeURIComponent(jobId)}`;
      const job = await callApi(user, path);
      if (stale()) return;
      if (job.status === 404 || job.status === 410) return setPhase({ name: 'not-found' });
      if (job.status !== 200) return setPhase({ name: 'unavailable' });
      const answer = await callApi(user, `${path}/estimate`);
      if (stale()) return;
      // The job is there, so a 404 here is the company's prices being switched off.
      if (answer.status === 404) return setPhase({ name: 'prices-off' });
      const read = answer.status === 200 ? reviewAnswerOf(answer.body) : null;
      const revision = answer.status === 200 ? revisionOf(answer.body) : null;
      if (!read || revision === null) return setPhase({ name: 'unavailable' });
      // A signed job opens read-only, from the agreement's stored bytes (S5a-11).
      let agreement: SignedAgreement | null = null;
      if (read.job.status === 'signed') {
        const signed = await callApi(user, `${path}/agreements`);
        if (stale()) return;
        const parsed = signed.status === 200 ? agreementAnswerOf(signed.body) : null;
        if (!parsed?.agreement) return setPhase({ name: 'unavailable' });
        agreement = parsed.agreement;
      }
      setPhase({ name: 'ready', user, reviewer, links: linkRightsOf(me.body), canReprice: canRepriceOf(me.body), revision, ...read, agreement });
    },
    [config, jobId, tenantId],
  );

  useEffect(() => {
    const auth = companyAuth({ config, tenantId });
    authRef.current = auth;
    return onAuthStateChanged(auth, (user) => {
      if (!user) return setPhase({ name: 'signed-out' });
      if (!belongsTo(user, tenantId)) return void signOutOrShow(() => signOutOnRefusal(auth, tenantId, config, 'not-this-company'), setPhase);
      void load(user);
    });
  }, [config, tenantId, load]);

  const signInLink = (
    <Button asChild variant="outline">
      <Link href={`/sign-in/${address}`}>Go to the {companyName} sign-in page</Link>
    </Button>
  );

  switch (phase.name) {
    case 'checking':
      return (
        <FocusedPanel title="Review before signing">
          <p role="status">Reading the job…</p>
        </FocusedPanel>
      );
    case 'signed-out':
      return (
        <FocusedPanel title="Sign in to review this job">
          <p>Sign in to {companyName} first.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'finish-sign-in':
      return (
        <FocusedPanel title="Finish signing in first">
          <p>Your sign-in is not finished yet. The sign-in page shows the next step.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'not-secured':
      return <WorkNotSecured retry={phase.retry} />;
    case 'not-found':
      return (
        <FocusedPanel title="This job could not be found">
          <p>It may belong to someone else, or it was archived.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'prices-off':
      return (
        <FocusedPanel title="Prices are not switched on">
          <p>Estimates need your company&apos;s prices, which are not switched on for {companyName} yet.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'unavailable':
      return (
        <FocusedPanel title="We could not open this job">
          <p>Review needs a connection. Check it, then try again.</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
          {signInLink}
        </FocusedPanel>
      );
    case 'ready':
      return <ReviewBody {...phase} finishHref={`/sign-in/${address}/jobs/${encodeURIComponent(jobId)}/finish`} reload={() => void load(phase.user)} />;
  }
}

function ReviewBody({ user, reviewer, links, canReprice, revision, job, estimate: first, agreement: signedFirst, finishHref, reload }: Ready & { finishHref: string; reload: () => void }) {
  const [estimate, setEstimate] = useState<EstimateView | null>(first);
  const [agreement, setAgreement] = useState<SignedAgreement | null>(signedFirst);
  const [issued, setIssued] = useState<{ tokens: IssuedLink[]; listed: DocumentLinkView[] }>({ tokens: [], listed: [] });
  const signatureId = agreement?.record.signature.id ?? null;
  const loadSignature = useCallback(() => (signatureId ? signatureAddress(user, job.id, signatureId) : Promise.resolve(null)), [user, job.id, signatureId]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; next: Next } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // Pricing is safe to send again: the same record and pin always answer the same estimate.
  async function price() {
    setBusy(true);
    setProblem(null);
    const answer = await callApi(user, `/api/jobs/${encodeURIComponent(job.id)}/estimate`, { method: 'POST' });
    setBusy(false);
    const made = answer.status === 200 || answer.status === 201 ? reviewAnswerOf(answer.body) : null;
    if (made?.estimate) return setEstimate(made.estimate);
    setProblem(outcomeOf(answer.status, answer.body));
  }

  const finishLink = (
    <Button asChild variant="outline">
      <Link href={finishHref}>Back to Finish and review</Link>
    </Button>
  );

  if (agreement) {
    return (
      <FocusedPanel title="Signed">
        <SignedAgreementView agreement={agreement} loadSignature={loadSignature} />
        <DocumentLinks user={user} jobId={job.id} canSend={links.canSend} canRevoke={links.canRevoke} issued={issued.tokens} listed={issued.listed} />
      </FocusedPanel>
    );
  }

  const repriceBanner = canReprice ? <RepriceBanner user={user} jobId={job.id} revision={revision} onChanged={reload} /> : null;

  if (!estimate) {
    return (
      <FocusedPanel title={job.status === 'draft' ? 'Not finished yet' : 'Price this job'}>
        {repriceBanner}
        {problem ? (
          <div role="alert" className="flex flex-col gap-3 rounded-md border border-red-700 p-3">
            <p>{problem.message}</p>
            {problem.next === 'retry' ? (
              <Button disabled={busy} onClick={() => void price()}>
                Try again
              </Button>
            ) : null}
            {problem.next === 'reload' ? (
              <Button variant="outline" disabled={busy} onClick={reload}>
                Reload the job
              </Button>
            ) : null}
          </div>
        ) : null}
        <p role="status">{busy ? 'Pricing…' : ''}</p>
        {job.status === 'draft' ? <p>This job is still being edited. Finish and review it, then come back to price it.</p> : null}
        {job.status === 'submitted' && reviewer.canPrice ? (
          <>
            <p className="text-sm">
              Pricing uses your company&apos;s published prices. The first time a job is priced, it keeps those prices from then on,
              even when new prices are published. It needs a connection.
            </p>
            <Button disabled={busy} onClick={() => void price()}>
              Price this job
            </Button>
          </>
        ) : null}
        {job.status === 'submitted' && !reviewer.canPrice ? <p>The owner or the estimator on this job prices it. It has not been priced yet.</p> : null}
        {finishLink}
      </FocusedPanel>
    );
  }

  const reasons = notReadyReasons(estimate);
  return (
    <FocusedPanel title="Review before signing">
      {repriceBanner}
      <EstimatePrice estimate={estimate} />
      <EstimateDocuments estimate={estimate} />
      <StaffNotes estimate={estimate} />
      {reasons.length ? (
        <section aria-labelledby="review-not-ready" className="flex flex-col gap-2 rounded-md border border-amber-700 p-3">
          <h2 id="review-not-ready" className="text-lg font-semibold">
            Not ready to sign
          </h2>
          <ul className="list-disc pl-5">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      ) : reviewer.canSign ? (
        <section aria-labelledby="review-confirm" className="flex flex-col gap-2">
          <h2 id="review-confirm" className="text-lg font-semibold">
            Before signing
          </h2>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 size-5 shrink-0" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>I reviewed the proposal, the separate totals and the attached evidence with the homeowner or representative.</span>
          </label>
          <p role="status" className="text-sm">
            {confirmed ? 'Documents confirmed.' : ''}
          </p>
          {confirmed ? (
            <SigningForm
              user={user}
              jobId={job.id}
              estimate={estimate}
              onSigned={(signed, tokens, listed) => {
                setIssued({ tokens, listed });
                setAgreement(signed);
              }}
            />
          ) : null}
        </section>
      ) : null}
      {!reasons.length && reviewer.canSign ? <SendLink user={user} jobId={job.id} estimate={estimate} /> : null}
      {finishLink}
    </FocusedPanel>
  );
}
