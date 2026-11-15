'use client';

import type { User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authenticatorCount, callApi } from '@/lib/firebase-client';
import { acrossUserReload, signInOf, type SignIn } from '@/lib/field/sign-out';
import type { LockReason } from '@/lib/field/unsent';
import {
  ACCEPT_SECOND_STEP_MESSAGE,
  ACCEPT_SIGN_IN_WITH_CODE_MESSAGE,
  acceptErrorMessage,
  acceptSecondStepNext,
  invitationOffer,
  roleLabel,
  type InvitationOffer,
} from '@/lib/team/screen';
import { FocusedPanel } from '../../focused-panel';
import { EnrolScreen } from '../../second-step/enrol-screen';
import { hadSecondStep, rememberSecondStep } from '../../second-step/remember';

type State =
  | { name: 'loading' }
  // Nothing for this account at this link: no such invitation, or one addressed to another email.
  // The server answers both the same way, and so does this screen.
  | { name: 'none' }
  | { name: 'offer'; offer: InvitationOffer }
  // The invitation's role needs an authenticator app (an owner, or office since 2026-11-14) and
  // the account has none: it is set up here, then accepting is tried again.
  | { name: 'second-step'; offer: InvitationOffer }
  | { name: 'unavailable' };

// "Accept invitation": what a signed-in person without a membership sees on an invitation link
// (/sign-in/{address}/invitations/{id}). The invitation is read from the server, which shows it
// only to the account whose verified email it is addressed to; accepting creates the membership
// once. `signOut` is the sign-in screen's own sign-out button; `onSignInAgain` signs out with a
// message; `onNeedsSignIn` is the sign-in screen's answer to Firebase wanting a newer sign-in.
export function InvitationScreen({
  invitationId,
  companyName,
  tenantId,
  user,
  onAccepted,
  onSignInAgain,
  onNeedsSignIn,
  signOut,
}: {
  invitationId: string;
  companyName: string;
  tenantId: string;
  user: User;
  onAccepted: () => Promise<void>;
  onSignInAgain: (message: string, refusal: LockReason, from?: SignIn) => void;
  onNeedsSignIn: (from: SignIn) => void;
  signOut: React.ReactNode;
}) {
  const [state, setState] = useState<State>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void callApi(user, `/api/invitations/${invitationId}`).then((answer) => {
      if (!current) return;
      if (answer.status === 200) {
        const offer = invitationOffer(answer.body);
        setState(offer ? { name: 'offer', offer } : { name: 'unavailable' });
      } else {
        setState(answer.status === 404 ? { name: 'none' } : { name: 'unavailable' });
      }
    });
    return () => {
      current = false;
    };
  }, [invitationId, user]);

  async function accept(offer: InvitationOffer) {
    setBusy(true);
    setError(null);
    // The sign-in this request is made with: a refusal of it ends that sign-in and no other.
    let from = signInOf(user);
    try {
      const answer = await callApi(user, `/api/invitations/${invitationId}/accept`, { method: 'POST' });
      if (answer.status === 200 || answer.status === 201) {
        await onAccepted();
        return;
      }
      const code = (answer.body as { error?: unknown } | null)?.error;
      if (answer.status === 403 && code === 'second_step_required') {
        let count: number | null;
        [count, from] = await acrossUserReload(from, () => authenticatorCount(user));
        const next = acceptSecondStepNext(count);
        if (next === 'set-up') setState({ name: 'second-step', offer });
        else if (next === 'sign-in-with-code') onSignInAgain(ACCEPT_SIGN_IN_WITH_CODE_MESSAGE, 'sign-in-again', from);
        else setError(ACCEPT_SECOND_STEP_MESSAGE);
        return;
      }
      setError(acceptErrorMessage(answer.status, answer.body));
    } finally {
      setBusy(false);
    }
  }

  if (state.name === 'loading') {
    return (
      <FocusedPanel title="Checking your invitation">
        <p role="status">Checking your invitation…</p>
      </FocusedPanel>
    );
  }
  if (state.name === 'unavailable') {
    return (
      <FocusedPanel title="We could not check your invitation">
        <p>Check your connection, then reload this page.</p>
        {signOut}
      </FocusedPanel>
    );
  }
  if (state.name === 'none') {
    return (
      <FocusedPanel title="Accept a company invitation before using this app">
        <p>
          You are signed in, but you are not on the {companyName} team yet, and there is no invitation at this link for
          your email address. Open the link the owner of {companyName} sent you, signed in with the email address they
          invited.
        </p>
        {signOut}
      </FocusedPanel>
    );
  }

  if (state.name === 'second-step') {
    // The setup screen the sign-in page shows a member who needs a second step, with no way past
    // it but setting one up or signing out. Once set up, accepting is tried again.
    const { offer } = state;
    return (
      <EnrolScreen
        user={user}
        companyName={companyName}
        mode="required"
        wasReset={hadSecondStep(tenantId, user.uid)}
        existingCount={0}
        onEnrolled={() => {
          rememberSecondStep(tenantId, user.uid);
          setState({ name: 'offer', offer });
          void accept(offer);
        }}
        onNeedsSignIn={onNeedsSignIn}
        onLeave={() => onSignInAgain('You are signed out.', 'second-step')}
      />
    );
  }

  const { offer } = state;
  return (
    <FocusedPanel title="Accept invitation">
      {offer.status === 'pending' ? (
        <>
          <p>
            {companyName} has invited you to join as <strong>{roleLabel(offer.role).toLowerCase()}</strong>.
          </p>
          <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
            {error ?? ''}
          </p>
          <Button disabled={busy} onClick={() => void accept(offer)}>
            Accept invitation
          </Button>
        </>
      ) : (
        <p>{OFFER_CLOSED[offer.status]?.(companyName)}</p>
      )}
      {signOut}
    </FocusedPanel>
  );
}

const OFFER_CLOSED: Partial<Record<InvitationOffer['status'], (company: string) => string>> = {
  expired: (company) => `This invitation has expired. Ask the owner of ${company} to send it again.`,
  cancelled: (company) => `This invitation was cancelled. Ask the owner of ${company} for a new one.`,
  accepted: () => 'This invitation has already been used.',
};
