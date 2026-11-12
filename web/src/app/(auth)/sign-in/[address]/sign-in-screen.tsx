'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BrowserSignInConfig } from '@/lib/config';
import {
  authenticatorCount,
  belongsTo,
  checkSignIn,
  companyAuth,
  sendSetPasswordEmail,
  sendVerifyEmail,
  signInWithGoogle,
  signInWithPassword,
  signOutCompany,
  type SecondStepChallenge,
} from '@/lib/firebase-client';
import { forgetMe, saveMe } from '@/lib/field/ds-me';
import { endsSession, errorCode, signInErrorMessage, type MeOutcome } from '@/lib/sign-in/outcome';
import { rememberSignInAddress } from '@/lib/sign-in/remember';
import { offersTeamScreen } from '@/lib/team/screen';
import { FocusedPanel } from '../../focused-panel';
import { Panel } from '../../panel';
import { CodeScreen } from '../../second-step/code-screen';
import { EnrolScreen } from '../../second-step/enrol-screen';
import { hadSecondStep, rememberSecondStep } from '../../second-step/remember';
import { SecondStepSection } from '../../second-step/second-step-section';
import { InvitationScreen } from './invitation-screen';

export type SignInScreenProps = {
  address: string;
  companyName: string;
  tenantId: string;
  // Set on an invitation link (/sign-in/{address}/invitations/{id}).
  invitationId: string | null;
  // null when sign-in is not set up for this environment yet.
  config: BrowserSignInConfig | null;
};

type Screen =
  | { name: 'starting' }
  | { name: 'signed-out' }
  | { name: 'set-password' }
  | { name: 'set-password-sent' }
  | { name: 'checking' }
  // The password or Google account was right and the person has a second step: the code is next.
  | { name: 'code'; challenge: SecondStepChallenge }
  // A signed-in person adds an authenticator app (the required first setup is the outcome below).
  | { name: 'add-authenticator'; existing: number }
  | { name: 'outcome'; outcome: Exclude<MeOutcome, { kind: 'sign-in-again' | 'not-this-company' | 'account-disabled' }> };

export function SignInScreen(props: SignInScreenProps) {
  if (!props.config) {
    return (
      <Panel title={`Sign in to ${props.companyName}`}>
        <p>Sign-in is not set up here yet. Try again later.</p>
      </Panel>
    );
  }
  return <CompanySignIn key={props.tenantId} {...props} config={props.config} />;
}

function CompanySignIn({ address, companyName, tenantId, invitationId, config }: SignInScreenProps & { config: BrowserSignInConfig }) {
  const [screen, setScreen] = useState<Screen>({ name: 'starting' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const authRef = useRef<Auth | null>(null);
  // The person signed in on this phone, for the screens that act on their account.
  const [signedInUser, setSignedInUser] = useState<User | null>(null);

  // Where emailed links (set your password, verify your email) come back to.
  const returnUrl = useCallback(() => `${window.location.origin}${window.location.pathname}`, []);

  const showSignedOut = useCallback(() => {
    setScreen((current) =>
      current.name === 'set-password' || current.name === 'set-password-sent' || current.name === 'code'
        ? current
        : { name: 'signed-out' },
    );
  }, []);

  const endSession = useCallback(async (message: string | null) => {
    const auth = authRef.current;
    const signedIn = auth?.currentUser ?? null;
    if (auth) await signOutCompany(auth);
    // The field shell no longer starts from this sign-in (S6-2).
    if (signedIn) void forgetMe(tenantId, signedIn.uid);
    setError(null);
    setNotice(message);
    setScreen({ name: 'signed-out' });
  }, [tenantId]);

  const refuse = useCallback(
    async (message: string) => {
      try {
        await endSession(message);
      } catch {
        setScreen({ name: 'outcome', outcome: { kind: 'unavailable' } });
      }
    },
    [endSession],
  );

  // When the server still wants the second step, Firebase is asked how many authenticator apps the
  // account has. Any at all means this sign-in did not use one (the session that set it up), so the
  // person signs in again with the app's code; none means setup, and when that cannot be read the
  // check is retried.
  const check = useCallback(
    async (user: User, fresh = false) => {
      setScreen({ name: 'checking' });
      const outcome = await checkSignIn(user, fresh);
      const authenticators = outcome.kind === 'second-step' ? await authenticatorCount(user) : 0;
      const current = authRef.current?.currentUser ?? null;
      if (current !== user) {
        if (!current) showSignedOut();
        return;
      }
      if (authenticators === null) {
        setScreen({ name: 'outcome', outcome: { kind: 'unavailable' } });
        return;
      }
      if (authenticators > 0) {
        await refuse('Your authenticator app is set up. Sign in again and enter its code.');
        return;
      }
      if (endsSession(outcome)) {
        const message =
          outcome.kind === 'not-this-company'
            ? `That sign-in is not for ${companyName}. Sign in with your ${companyName} account.`
            : outcome.kind === 'account-disabled'
              ? `This account is turned off. Ask the owner of ${companyName}.`
              : 'Please sign in again.';
        await refuse(message);
        return;
      }
      // The field shell starts from this row with no signal (S6-2); a phone that cannot keep it
      // still signs in, and the shell says it is not saved.
      if (outcome.kind === 'signed-in') {
        void saveMe({ tenantId, uid: user.uid, companyName: outcome.companyName, address, config });
      }
      setScreen({ name: 'outcome', outcome: outcome as Extract<Screen, { name: 'outcome' }>['outcome'] });
    },
    [address, companyName, config, refuse, showSignedOut, tenantId],
  );

  useEffect(() => {
    rememberSignInAddress(address);
    const auth = companyAuth({ config, tenantId });
    authRef.current = auth;
    return onAuthStateChanged(auth, (user) => {
      setSignedInUser(user);
      if (!user) {
        showSignedOut();
        return;
      }
      // Belt and braces: this company's Auth instance only ever holds this tenant's sign-in.
      if (!belongsTo(user, tenantId)) {
        void refuse(`That sign-in is not for ${companyName}.`);
        return;
      }
      void check(user);
    });
  }, [address, check, companyName, config, refuse, showSignedOut, tenantId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(signInErrorMessage(errorCode(failure), companyName));
    } finally {
      setBusy(false);
    }
  }

  // Firebase wants a newer sign-in before it changes a second step.
  const needsFreshSignIn = useCallback(() => {
    void refuse('For your safety, sign in again before changing your second step.');
  }, [refuse]);

  const auth = () => authRef.current!;
  const currentUser = () => authRef.current?.currentUser ?? null;

  const signOutButton = (
    <>
      <ErrorMessage text={error} />
      <Button variant="outline" disabled={busy} onClick={() => run(() => endSession('You are signed out.'))}>
        Sign out
      </Button>
    </>
  );

  if (screen.name === 'starting' || screen.name === 'checking') {
    return (
      <FocusedPanel title={`Sign in to ${companyName}`}>
        <p role="status">Checking your sign-in…</p>
      </FocusedPanel>
    );
  }

  if (screen.name === 'code') {
    return (
      <CodeScreen
        challenge={screen.challenge}
        onVerified={(uid) => rememberSecondStep(tenantId, uid)}
        onExpired={() => {
          setNotice('That sign-in timed out. Sign in again.');
          setScreen({ name: 'signed-out' });
        }}
        onBack={() => {
          setError(null);
          setNotice(null);
          setScreen({ name: 'signed-out' });
        }}
      />
    );
  }

  if (screen.name === 'add-authenticator') {
    const user = signedInUser;
    if (user) {
      return (
        <EnrolScreen
          user={user}
          companyName={companyName}
          mode="add"
          wasReset={false}
          existingCount={screen.existing}
          onEnrolled={() => {
            rememberSecondStep(tenantId, user.uid);
            void check(user);
          }}
          onNeedsSignIn={needsFreshSignIn}
          onLeave={() => void check(user)}
        />
      );
    }
  }

  if (screen.name === 'set-password') {
    return (
      <FocusedPanel title="Set your own password">
        <p>
          First time here, or forgot your password? Enter your email address and we will send you a link to choose a
          password for {companyName}.
        </p>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await sendSetPasswordEmail(auth(), email, returnUrl());
              setScreen({ name: 'set-password-sent' });
            });
          }}
        >
          <EmailField value={email} onChange={setEmail} />
          <ErrorMessage text={error} />
          <Button type="submit" disabled={busy}>
            Send the link
          </Button>
        </form>
        <Button variant="outline" onClick={() => { setError(null); setScreen({ name: 'signed-out' }); }}>
          Back to sign in
        </Button>
      </FocusedPanel>
    );
  }

  if (screen.name === 'set-password-sent') {
    return (
      <FocusedPanel title="Check your email">
        <p role="status">
          If {companyName} has an account for that email address, a link to set your password is on its way. Open it,
          choose a password, then sign in here.
        </p>
        <Button variant="outline" onClick={() => setScreen({ name: 'signed-out' })}>
          Back to sign in
        </Button>
      </FocusedPanel>
    );
  }

  if (screen.name === 'outcome') {
    const { outcome } = screen;
    switch (outcome.kind) {
      case 'signed-in':
        return (
          <FocusedPanel title={`Signed in to ${outcome.companyName}`}>
            <p>
              You are signed in as {ROLE_NAMES[outcome.role] ?? 'a team member'}. The rest of DryScope arrives in later
              updates.
            </p>
            {signedInUser ? (
              <SecondStepSection
                user={signedInUser}
                onAdd={(existing) => setScreen({ name: 'add-authenticator', existing })}
              />
            ) : null}
            <Button asChild>
              <a href="/field">Open the field app</a>
            </Button>
            {offersTeamScreen(outcome.role) ? (
              <Button asChild>
                <Link href={`/sign-in/${address}/team`}>Team and invitations</Link>
              </Button>
            ) : null}
            {signOutButton}
          </FocusedPanel>
        );
      case 'verify-email':
        return (
          <FocusedPanel title="Verify your email">
            <p>
              Before you can use DryScope, we need to know this email address is yours. Send yourself a link, open it,
              then come back here.
            </p>
            <StatusMessage text={notice} />
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const user = currentUser();
                  if (!user) return;
                  await sendVerifyEmail(user, returnUrl());
                  setNotice('Link sent. Check your email.');
                })
              }
            >
              Send the link
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const user = currentUser();
                  if (user) await check(user, true);
                })
              }
            >
              I have verified it
            </Button>
            {signOutButton}
          </FocusedPanel>
        );
      case 'needs-invitation': {
        // On an invitation link, offer the invitation to the account it is addressed to.
        const user = signedInUser;
        if (invitationId && user) {
          return (
            <InvitationScreen
              invitationId={invitationId}
              companyName={companyName}
              user={user}
              onAccepted={() => check(user, true)}
              signOut={signOutButton}
            />
          );
        }
        return (
          <FocusedPanel title="Accept a company invitation before using this app">
            <p>
              You are signed in, but you are not on the {companyName} team yet. Open the invitation link the owner of{' '}
              {companyName} sent you.
            </p>
            {signOutButton}
          </FocusedPanel>
        );
      }
      case 'member-disabled':
        return (
          <FocusedPanel title="Your access is turned off">
            <p>Ask the owner of {companyName} to turn it back on.</p>
            {signOutButton}
          </FocusedPanel>
        );
      case 'company-inactive':
        return (
          <FocusedPanel title={`${companyName} is not active`}>
            <p>Sign-in is paused for this company. Contact DryScope support.</p>
            {signOutButton}
          </FocusedPanel>
        );
      case 'second-step': {
        // The only screen a person who needs a second step and has none can reach: no skip, no way
        // on to the app, only setting it up or signing out.
        const user = signedInUser;
        if (!user) return null;
        return (
          <EnrolScreen
            user={user}
            companyName={companyName}
            mode="required"
            wasReset={hadSecondStep(tenantId, user.uid)}
            existingCount={0}
            onEnrolled={() => {
              rememberSecondStep(tenantId, user.uid);
              void check(user);
            }}
            onNeedsSignIn={needsFreshSignIn}
            onLeave={() => void refuse('You are signed out.')}
          />
        );
      }
      case 'unavailable':
        return (
          <FocusedPanel title="We could not check your sign-in">
            <p>Check your connection, then try again.</p>
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const user = currentUser();
                  if (user) await check(user, true);
                  else await endSession(null);
                })
              }
            >
              Try again
            </Button>
            {signOutButton}
          </FocusedPanel>
        );
    }
  }

  return (
    <FocusedPanel title={`Sign in to ${companyName}`}>
      {invitationId ? (
        <p>
          You have been invited to {companyName}. First time here? Choose <strong>Set your own password</strong>.
        </p>
      ) : null}
      <StatusMessage text={notice} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            setNotice(null);
            const challenge = await signInWithPassword(auth(), email, password);
            setPassword('');
            if (challenge) setScreen({ name: 'code', challenge });
          });
        }}
      >
        <EmailField value={email} onChange={setEmail} />
        <div className="flex flex-col gap-1">
          <label htmlFor="sign-in-password" className="font-medium">
            Password
          </label>
          <Input
            id="sign-in-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <ErrorMessage text={error} />
        <Button type="submit" disabled={busy}>
          Sign in
        </Button>
      </form>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          run(async () => {
            setNotice(null);
            const challenge = await signInWithGoogle(auth());
            if (challenge) setScreen({ name: 'code', challenge });
          })
        }
      >
        Sign in with Google
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setError(null);
          setNotice(null);
          setScreen({ name: 'set-password' });
        }}
      >
        Set your own password
      </Button>
    </FocusedPanel>
  );
}

const ROLE_NAMES: Record<string, string> = { owner: 'the owner', estimator: 'an estimator', office: 'office staff' };

function EmailField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="sign-in-email" className="font-medium">
        Email
      </label>
      <Input
        id="sign-in-email"
        type="email"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ErrorMessage({ text }: { text: string | null }) {
  return (
    <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
      {text ?? ''}
    </p>
  );
}

function StatusMessage({ text }: { text: string | null }) {
  return (
    <p role="status" className="text-sm empty:hidden">
      {text ?? ''}
    </p>
  );
}
