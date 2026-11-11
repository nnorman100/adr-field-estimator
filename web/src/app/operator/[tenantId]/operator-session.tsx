'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BrowserSignInConfig } from '@/lib/config';
import { belongsTo, companyAuth, signInWithGoogle, signInWithPassword, signOutCompany } from '@/lib/firebase-client';
import { operatorCall, platformPaths, type ApiResult, type CompaniesAnswer, type CompanyView } from '@/lib/operator/client';
import { endsOperatorSession, operatorCheck, operatorSignInErrorMessage } from '@/lib/operator/screens';
import { errorCode } from '@/lib/sign-in/outcome';
import { FocusedPanel } from '../../(auth)/focused-panel';
import { Panel } from '../../(auth)/panel';
import { ErrorMessage, Field, StatusMessage } from './ui';

// The platform operator's session for every operator screen (S3-15). It signs in to the operator
// tenant only (owner decision D6), then asks the server who this is by reading the company list,
// which only an active operator with a second step and a recent sign-in may do. Until that answer
// is "operator", no screen draws. Everything else (a company owner, an unverified email, a missing
// second step) gets a short message and no data, and a sign-in that is not an operator's is dropped
// from the phone. Who may do what is decided by the server on every call, never by this file.

export type OperatorApi = {
  tenantId: string;
  companies: CompanyView[];
  reload: () => Promise<void>;
  call: <T>(path: string, request?: { method?: 'GET' | 'POST'; body?: unknown }) => Promise<ApiResult<T>>;
  // A change to a team or a second step needs a sign-in under 15 minutes old: sign out, then sign in.
  signInAgain: () => Promise<void>;
};

const Session = createContext<OperatorApi | null>(null);

export function useOperator(): OperatorApi {
  const api = useContext(Session);
  if (!api) throw new Error('useOperator needs the operator session');
  return api;
}

type Phase =
  | { name: 'starting' }
  | { name: 'signed-out' }
  | { name: 'checking' }
  | { name: 'refused'; reason: 'verify-email' | 'second-step' | 'unavailable' }
  | { name: 'ready' };

export function OperatorSession({
  tenantId,
  config,
  children,
}: {
  tenantId: string;
  config: BrowserSignInConfig | null;
  children: React.ReactNode;
}) {
  if (!config) {
    return (
      <Panel title="Platform operator sign-in">
        <p>Sign-in is not set up here yet. Try again later.</p>
      </Panel>
    );
  }
  return (
    <ConfiguredSession key={tenantId} tenantId={tenantId} config={config}>
      {children}
    </ConfiguredSession>
  );
}

function ConfiguredSession({ tenantId, config, children }: { tenantId: string; config: BrowserSignInConfig; children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ name: 'starting' });
  const [companies, setCompanies] = useState<CompanyView[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const authRef = useRef<Auth | null>(null);

  const showSignedOut = useCallback(() => setPhase({ name: 'signed-out' }), []);

  const endSession = useCallback(async (message: string | null) => {
    const auth = authRef.current;
    if (auth) await signOutCompany(auth);
    setNotice(message);
    setCompanies([]);
    setPhase({ name: 'signed-out' });
  }, []);

  const refuse = useCallback(
    async (message: string) => {
      try {
        await endSession(message);
      } catch {
        setPhase({ name: 'refused', reason: 'unavailable' });
      }
    },
    [endSession],
  );

  // Reads the company list as the check of who this is. `user` is the sign-in being checked: if it
  // changed meanwhile, the answer is dropped.
  const check = useCallback(
    async (user: User) => {
      setPhase({ name: 'checking' });
      const result = await operatorCall<CompaniesAnswer>(user, platformPaths.companies());
      const current = authRef.current?.currentUser ?? null;
      if (current !== user) {
        if (!current) showSignedOut();
        return;
      }
      const outcome = operatorCheck(result.status, result.ok ? null : result.code);
      if (outcome.kind === 'operator') {
        if (result.ok && Array.isArray(result.body.companies)) {
          setCompanies(result.body.companies);
          setPhase({ name: 'ready' });
        } else {
          setPhase({ name: 'refused', reason: 'unavailable' });
        }
        return;
      }
      if (endsOperatorSession(outcome)) {
        await refuse(
          outcome.kind === 'not-operator' ? 'This account is not a platform operator.' : 'Please sign in again.',
        );
        return;
      }
      setPhase({ name: 'refused', reason: outcome.kind === 'verify-email' ? 'verify-email' : outcome.kind === 'second-step' ? 'second-step' : 'unavailable' });
    },
    [refuse, showSignedOut],
  );

  useEffect(() => {
    const auth = companyAuth({ config, tenantId });
    authRef.current = auth;
    return onAuthStateChanged(auth, (user) => {
      if (!user) {
        showSignedOut();
        return;
      }
      // This page's Auth instance only ever holds the operator tenant's sign-in.
      if (!belongsTo(user, tenantId)) {
        void refuse('This account is not a platform operator.');
        return;
      }
      void check(user);
    });
  }, [check, config, refuse, showSignedOut, tenantId]);

  const call = useCallback(
    async <T,>(path: string, request?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<ApiResult<T>> => {
      const user = authRef.current?.currentUser ?? null;
      if (!user) return { ok: false, status: 401, code: 'invalid_token' };
      const result = await operatorCall<T>(user, path, request);
      if (!result.ok) {
        const outcome = operatorCheck(result.status, result.code);
        // The server stopped treating this sign-in as an operator's (turned off, or a second step
        // no longer present): nothing more is drawn from it.
        if (outcome.kind === 'not-operator') void refuse('This account is not a platform operator.');
        else if (outcome.kind === 'second-step') setPhase({ name: 'refused', reason: 'second-step' });
        else if (outcome.kind === 'verify-email') setPhase({ name: 'refused', reason: 'verify-email' });
      }
      return result;
    },
    [refuse],
  );

  const reload = useCallback(async () => {
    const result = await call<CompaniesAnswer>(platformPaths.companies());
    if (result.ok && Array.isArray(result.body.companies)) setCompanies(result.body.companies);
  }, [call]);

  const signInAgain = useCallback(() => endSession('For that change, sign in again.'), [endSession]);

  const api = useMemo<OperatorApi>(
    () => ({ tenantId, companies, reload, call, signInAgain }),
    [tenantId, companies, reload, call, signInAgain],
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(operatorSignInErrorMessage(errorCode(failure)));
    } finally {
      setBusy(false);
    }
  }

  const auth = () => authRef.current!;
  const signOutButton = (
    <>
      <ErrorMessage text={error} />
      <Button variant="outline" disabled={busy} onClick={() => run(() => endSession('You are signed out.'))}>
        Sign out
      </Button>
    </>
  );

  if (phase.name === 'ready') {
    return (
      <Session.Provider value={api}>
        <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 py-6">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold tracking-wide">DryScope · Platform operator</p>
            <Button variant="outline" disabled={busy} onClick={() => run(() => endSession('You are signed out.'))}>
              Sign out
            </Button>
          </header>
          <nav aria-label="Operator">
            <Link href={`/operator/${tenantId}`} className="font-medium underline underline-offset-4">
              Companies
            </Link>
          </nav>
          <ErrorMessage text={error} />
          {children}
        </main>
      </Session.Provider>
    );
  }

  if (phase.name === 'starting' || phase.name === 'checking') {
    return (
      <FocusedPanel title="Platform operator sign-in">
        <p role="status">Checking your sign-in…</p>
      </FocusedPanel>
    );
  }

  if (phase.name === 'refused') {
    switch (phase.reason) {
      case 'verify-email':
        return (
          <FocusedPanel title="Verify your email">
            <p>This account’s email address is not verified yet, so it cannot be used for platform operator work.</p>
            {signOutButton}
          </FocusedPanel>
        );
      case 'second-step':
        return (
          <FocusedPanel title="Set up your second sign-in step">
            <p>
              Platform operators must use an authenticator app as a second sign-in step. Setting it up from this screen
              arrives in the next update.
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
                  const user = authRef.current?.currentUser ?? null;
                  if (user) await check(user);
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
    <FocusedPanel title="Platform operator sign-in">
      <p>For DryScope platform operators only.</p>
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
        <Field
          id="operator-email"
          label="Email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="operator-password" className="font-medium">
            Password
          </label>
          <Input
            id="operator-password"
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
    </FocusedPanel>
  );
}
