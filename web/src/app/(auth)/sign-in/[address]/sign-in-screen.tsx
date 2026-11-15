'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RecaptchaNotice } from '@/components/recaptcha-notice';
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
  type SecondStepChallenge,
} from '@/lib/firebase-client';
import { saveMe } from '@/lib/field/ds-me';
import { prepareFieldShell } from '@/lib/field/register-worker';
import { meFacts } from '@/lib/field/sync-gate';
import { evaluate, watchRetention } from '@/lib/field/retention';
import type { LockReason } from '@/lib/field/unsent';
import {
  hasUnsentWork,
  signOutDiscarding,
  signOutKeeping,
  signOutOnRefusal,
  signInOf,
  signOutOrShow,
  WorkNotSecuredError,
  type FailedSignOut,
  type SignIn,
} from '@/lib/field/sign-out';
import { endsSession, errorCode, signInErrorMessage, type MeOutcome } from '@/lib/sign-in/outcome';
import { rememberSignInAddress } from '@/lib/sign-in/remember';
import { offersCompanyScreen } from '@/lib/profile/screen';
import { offersTeamScreen } from '@/lib/team/screen';
import { FocusedPanel } from '../../focused-panel';
import { Panel } from '../../panel';
import { CodeScreen } from '../../second-step/code-screen';
import { EnrolScreen } from '../../second-step/enrol-screen';
import { hadSecondStep, rememberSecondStep } from '../../second-step/remember';
import { SecondStepSection } from '../../second-step/second-step-section';
import { InvitationScreen } from './invitation-screen';
import { UnsentSignOutDialog, type UnsentChoice } from './unsent-sign-out-dialog';
import { NOT_READY_OFFLINE_TEXT, PREPARING_TEXT } from './offline-ready-text';
import { WorkNotSecured } from './work-not-secured';

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
  // Signed in: the field worker is being installed so the field app opens with no signal.
  | { name: 'preparing' }
  // A sign-out the app had to make could not save the refusal first: nothing was signed out, and
  // `retry` makes that sign-out again.
  | { name: 'not-secured'; retry: () => Promise<void> }
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
  const [askUnsent, setAskUnsent] = useState(false);
  // False when the field app could not be made ready to open with no signal during this sign-in.
  const [offlineReady, setOfflineReady] = useState(true);
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

  // `refusal`: why the app ends the session, kept for the 30-day limit (O5); 'kept' for the person's
  // own sign-out that keeps their work.
  const signedOut = useCallback((message: string | null) => {
    setError(null);
    setNotice(message);
    setScreen({ name: 'signed-out' });
  }, []);

  const endSession = useCallback(
    async (message: string | null, refusal: LockReason | 'kept') => {
      const auth = authRef.current;
      if (auth) await (refusal === 'kept' ? signOutKeeping(auth, tenantId) : signOutOnRefusal(auth, tenantId, config, refusal));
      signedOut(message);
    },
    [config, signedOut, tenantId],
  );

  const showFailed = useCallback(
    (failed: FailedSignOut) => setScreen(failed.name === 'not-secured' ? failed : { name: 'outcome', outcome: { kind: 'unavailable' } }),
    [],
  );

  // `fromServer`: the server's own answer refused the person just now (decision 010). `from`: the
  // sign-in refused, kept when the request was sent; the current one when left out.
  const refuse = useCallback(
    (message: string, refusal: LockReason, fromServer = false, from?: SignIn) => {
      const auth = authRef.current;
      return signOutOrShow(
        async () => {
          if (auth) await signOutOnRefusal(auth, tenantId, config, refusal, fromServer, from);
        },
        showFailed,
        () => signedOut(message),
      );
    },
    [config, showFailed, signedOut, tenantId],
  );

  // When the server still wants the second step, Firebase is asked how many authenticator apps the
  // account has. Any at all means this sign-in did not use one (the session that set it up), so the
  // person signs in again with the app's code; none means setup, and when that cannot be read the
  // check is retried.
  const check = useCallback(
    async (user: User, fresh = false) => {
      setScreen({ name: 'checking' });
      // The sign-in this check is for: the same person signing in again in another tab keeps the
      // user object, so its time tells them apart.
      const signedInAt = user.metadata.lastSignInTime;
      const stillCurrent = () => authRef.current?.currentUser === user && user.metadata.lastSignInTime === signedInAt;
      const from = signInOf(user);
      const { outcome, body } = await checkSignIn(user, fresh);
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
        await refuse('Your authenticator app is set up. Sign in again and enter its code.', 'sign-in-again', false, from);
        return;
      }
      if (endsSession(outcome)) {
        const message =
          outcome.kind === 'not-this-company'
            ? `That sign-in is not for ${companyName}. Sign in with your ${companyName} account.`
            : outcome.kind === 'account-disabled'
              ? `This account is turned off. Ask the owner of ${companyName}.`
              : 'Please sign in again.';
        await refuse(message, outcome.kind, true, from);
        return;
      }
      // The field shell starts from this row with no signal (S6-2), so it is saved before the screen
      // that opens the shell, with what the server said and when the person signed in, for the
      // offline `me` read (S6-3); a phone that cannot keep it still signs in, and the shell says it
      // is not saved. The field worker is installed here too, and the signed-in screen waits for
      // it ("Getting DryScope ready…"), so a phone that loses signal before ever opening the field
      // app can still open it; when that does not finish in time, the screen says so. The server
      // just let this person in, so once the row is saved a refusal saved on the phone for them is
      // lifted, however old (decision 010; retention.ts). The row goes first, so the phone never
      // finds an old sign-in with no lock. A phone that cannot save the lifting offers nothing of
      // the field app: "Try again" lifts it again.
      if (outcome.kind === 'signed-in') {
        const authTime = await user.getIdTokenResult().then(
          (result) => Date.parse(result.authTime),
          () => NaN,
        );
        if (!stillCurrent()) return;
        await saveMe({
          tenantId,
          uid: user.uid,
          companyName: outcome.companyName,
          address,
          config,
          role: outcome.role,
          ...(meFacts(body) ?? {}),
          ...(Number.isFinite(authTime) ? { authTime } : {}),
        });
        const signedIn = outcome;
        async function openField(): Promise<void> {
          if (!stillCurrent()) return;
          const { state } = evaluate(Date.now(), { kind: 'let-in', person: { tenantId, uid: user.uid, config } });
          if (state === 'unsaved') return setScreen({ name: 'not-secured', retry: openField });
          setScreen({ name: 'preparing' });
          const ready = await prepareFieldShell();
          if (!stillCurrent()) return;
          setOfflineReady(ready);
          setScreen({ name: 'outcome', outcome: signedIn });
        }
        return openField();
      }
      setScreen({ name: 'outcome', outcome: outcome as Extract<Screen, { name: 'outcome' }>['outcome'] });
    },
    [address, companyName, config, refuse, showSignedOut, tenantId],
  );

  // The phone's retention routine (O5, S6-3b), for anyone on this phone: as the page opens and each
  // time it is shown again.
  useEffect(() => watchRetention({ tenantId, config }), [config, tenantId]);

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
        void refuse(`That sign-in is not for ${companyName}.`, 'not-this-company');
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

  // Firebase wants a newer sign-in before it changes a second step: `from`, the sign-in the
  // authenticator request was made with, is the one that ends.
  const needsFreshSignIn = useCallback(
    (from: SignIn) => {
      void refuse('For your safety, sign in again before changing your second step.', 'sign-in-again', false, from);
    },
    [refuse],
  );

  const auth = () => authRef.current!;
  const currentUser = () => authRef.current?.currentUser ?? null;

  // The person's own sign-out (S6-3). With work kept on this phone that the server does not have
  // yet, it asks to keep or discard it; otherwise, and on Discard, this person's cache for this
  // company goes too. Kept work stays for the same person's next sign-in here (D7). Work made only
  // in a window's memory (Online only) is not kept by anything, so nothing is promised for it.
  // A saved sign-in past its role's limit is locked before it goes; a phone that cannot save that
  // keeps the sign-in and offers "Try again", which finishes this sign-out.
  const signOutChosen = (choice: UnsentChoice) =>
    run(async () => {
      const message = choice === 'keep' ? 'You are signed out. Your unsent work is kept on this phone.' : 'You are signed out.';
      try {
        if (choice === 'keep') return await endSession(message, 'kept');
        const result = await signOutDiscarding(auth(), tenantId, config);
        if (result === 'elsewhere') return setError('DryScope is open in another window. Close it there, then sign out.');
        if (result === 'failed') return setError('Your work on this phone could not be removed. Try again.');
        signedOut(message);
      } catch (failure) {
        if (!(failure instanceof WorkNotSecuredError)) throw failure;
        setScreen({ name: 'not-secured', retry: () => signOutOrShow(failure.retry, showFailed, () => signedOut(message)) });
      }
    });

  const signOutButton = (
    <>
      <ErrorMessage text={error} />
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => (hasUnsentWork(auth(), tenantId) === 'kept' ? setAskUnsent(true) : void signOutChosen('discard'))}
      >
        Sign out
      </Button>
      <UnsentSignOutDialog
        open={askUnsent}
        companyName={companyName}
        onChoice={(choice) => {
          setAskUnsent(false);
          if (choice) void signOutChosen(choice);
        }}
      />
    </>
  );

  if (screen.name === 'starting' || screen.name === 'checking') {
    return (
      <FocusedPanel title={`Sign in to ${companyName}`}>
        <p role="status">Checking your sign-in…</p>
      </FocusedPanel>
    );
  }

  if (screen.name === 'not-secured') return <WorkNotSecured retry={screen.retry} />;

  if (screen.name === 'preparing') {
    return (
      <FocusedPanel title={`Sign in to ${companyName}`}>
        <p role="status">{PREPARING_TEXT}</p>
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
            {offlineReady ? null : <p role="status">{NOT_READY_OFFLINE_TEXT}</p>}
            {signedInUser ? (
              <SecondStepSection
                user={signedInUser}
                onAdd={(existing) => setScreen({ name: 'add-authenticator', existing })}
              />
            ) : null}
            {busy ? null : (
              <Button asChild>
                <a href="/field">Open the field app</a>
              </Button>
            )}
            {offersTeamScreen(outcome.role) ? (
              <Button asChild>
                <Link href={`/sign-in/${address}/team`}>Team and invitations</Link>
              </Button>
            ) : null}
            {offersCompanyScreen(outcome.role) ? (
              <Button asChild>
                <Link href={`/sign-in/${address}/company`}>Company settings</Link>
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
              tenantId={tenantId}
              user={user}
              onAccepted={() => check(user, true)}
              onSignInAgain={(message, refusal, from) => void refuse(message, refusal, false, from)}
              onNeedsSignIn={needsFreshSignIn}
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
            onLeave={() => void refuse('You are signed out.', 'second-step')}
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
                  else await endSession(null, 'sign-in-again');
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
      <RecaptchaNotice config={config} />
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
