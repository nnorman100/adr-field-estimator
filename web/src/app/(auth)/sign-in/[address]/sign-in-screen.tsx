'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BrowserSignInConfig } from '@/lib/config';
import {
  belongsTo,
  checkSignIn,
  companyAuth,
  sendSetPasswordEmail,
  sendVerifyEmail,
  signInWithGoogle,
  signInWithPassword,
  signOutCompany,
} from '@/lib/firebase-client';
import { endsSession, errorCode, signInErrorMessage, type MeOutcome } from '@/lib/sign-in/outcome';
import { rememberSignInAddress } from '@/lib/sign-in/remember';
import { FocusedPanel } from '../../focused-panel';
import { Panel } from '../../panel';

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
  | { name: 'outcome'; outcome: Exclude<MeOutcome, { kind: 'sign-in-again' | 'not-this-company' | 'account-disabled' }> };

export function SignInScreen(props: SignInScreenProps) {
  if (!props.config) {
    return (
      <Panel title={`Sign in to ${props.companyName}`}>
        <p>Sign-in is not set up here yet. Try again later.</p>
      </Panel>
    );
  }
  return <CompanySignIn {...props} config={props.config} />;
}

function CompanySignIn({ address, companyName, tenantId, invitationId, config }: SignInScreenProps & { config: BrowserSignInConfig }) {
  const [screen, setScreen] = useState<Screen>({ name: 'starting' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const authRef = useRef<Auth | null>(null);

  // Where emailed links (set your password, verify your email) come back to.
  const returnUrl = useCallback(() => `${window.location.origin}${window.location.pathname}`, []);

  const endSession = useCallback(async (message: string | null) => {
    const auth = authRef.current;
    if (auth) await signOutCompany(auth).catch(() => undefined);
    setNotice(message);
    setScreen({ name: 'signed-out' });
  }, []);

  const check = useCallback(
    async (user: User, fresh = false) => {
      setScreen({ name: 'checking' });
      const outcome = await checkSignIn(user, fresh);
      if (endsSession(outcome)) {
        const message =
          outcome.kind === 'not-this-company'
            ? `That sign-in is not for ${companyName}. Sign in with your ${companyName} account.`
            : outcome.kind === 'account-disabled'
              ? `This account is turned off. Ask the owner of ${companyName}.`
              : 'Please sign in again.';
        await endSession(message);
        return;
      }
      setScreen({ name: 'outcome', outcome: outcome as Extract<Screen, { name: 'outcome' }>['outcome'] });
    },
    [companyName, endSession],
  );

  useEffect(() => {
    rememberSignInAddress(address);
    const auth = companyAuth({ config, tenantId });
    authRef.current = auth;
    return onAuthStateChanged(auth, (user) => {
      if (!user) {
        setScreen((current) => (current.name === 'set-password' || current.name === 'set-password-sent' ? current : { name: 'signed-out' }));
        return;
      }
      // Belt and braces: this company's Auth instance only ever holds this tenant's sign-in.
      if (!belongsTo(user, tenantId)) {
        void endSession(`That sign-in is not for ${companyName}.`);
        return;
      }
      void check(user);
    });
  }, [address, check, companyName, config, endSession, tenantId]);

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

  const auth = () => authRef.current!;
  const currentUser = () => authRef.current?.currentUser ?? null;

  const signOutButton = (
    <Button variant="outline" disabled={busy} onClick={() => run(() => endSession('You are signed out.'))}>
      Sign out
    </Button>
  );

  if (screen.name === 'starting' || screen.name === 'checking') {
    return (
      <FocusedPanel title={`Sign in to ${companyName}`}>
        <p role="status">Checking your sign-in…</p>
      </FocusedPanel>
    );
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
            <ErrorMessage text={error} />
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
      case 'needs-invitation':
        return (
          <FocusedPanel title="Accept a company invitation before using this app">
            <p>
              You are signed in, but you are not on the {companyName} team yet. Open the invitation link the owner of{' '}
              {companyName} sent you.
            </p>
            {signOutButton}
          </FocusedPanel>
        );
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
      case 'second-step':
        return (
          <FocusedPanel title="Set up your second sign-in step">
            <p>
              Your role needs an authenticator app as a second sign-in step. Setting it up from this screen arrives in
              the next update.
            </p>
            {signOutButton}
          </FocusedPanel>
        );
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
                  else setScreen({ name: 'signed-out' });
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
            await signInWithPassword(auth(), email, password);
            setPassword('');
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
            await signInWithGoogle(auth());
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
