'use client';

import type { User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { finishAuthenticatorSetup, startAuthenticatorSetup, type AuthenticatorSetup } from '@/lib/firebase-client';
import { signInOf, type SignIn } from '@/lib/field/sign-out';
import { errorCode } from '@/lib/sign-in/outcome';
import {
  CODE_SHAPE_MESSAGE,
  authenticatorName,
  enrolErrorMessage,
  enrolNeedsFreshSignIn,
  groupedKey,
  normalizeCode,
  secondStepExpired,
} from '@/lib/sign-in/second-step';
import { FocusedPanel } from '../focused-panel';
import { QrCode } from './qr-code';

export type EnrolScreenProps = {
  user: User;
  companyName: string;
  // 'required': the role needs a second step and the person has none, so this is the only screen
  // they can reach. 'add': a signed-in person adds an authenticator app (a spare, or their first).
  mode: 'required' | 'add';
  // The phone remembers a second step that is gone now: it was reset (owner decision D9).
  wasReset: boolean;
  // Authenticator apps the person has already, for the name the new one is saved under.
  existingCount: number;
  onEnrolled: () => void;
  // Firebase wants a newer sign-in before it changes a second step: `from`, the sign-in the request
  // was made with.
  onNeedsSignIn: (from: SignIn) => void;
  // Sign out ('required') or go back ('add').
  onLeave: () => void;
};

// Setting up an authenticator app (S3-14): a QR code, the same key to type, and a code from the app
// to prove it works. The key and the code are never logged or put in a message.
export function EnrolScreen(props: EnrolScreenProps) {
  // "Start again" mounts the screen afresh, with a new key from Firebase and nothing typed.
  const [attempt, setAttempt] = useState(0);
  return <EnrolAttempt key={attempt} {...props} onStartAgain={() => setAttempt((count) => count + 1)} />;
}

function EnrolAttempt({
  user,
  companyName,
  mode,
  wasReset,
  existingCount,
  onEnrolled,
  onNeedsSignIn,
  onLeave,
  onStartAgain,
}: EnrolScreenProps & { onStartAgain: () => void }) {
  const [setup, setSetup] = useState<AuthenticatorSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The key can no longer be used: start again for a new one.
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let current = true;
    const from = signInOf(user);
    startAuthenticatorSetup(user, `DryScope ${companyName}`).then(
      (started) => {
        if (current) setSetup(started);
      },
      (failure: unknown) => {
        if (!current) return;
        const failed = errorCode(failure);
        if (enrolNeedsFreshSignIn(failed)) onNeedsSignIn(from);
        else {
          setError(enrolErrorMessage(failed));
          setExpired(true);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [user, companyName, onNeedsSignIn]);

  async function submit() {
    if (!setup) return;
    const digits = normalizeCode(code);
    if (digits === null) {
      setError(CODE_SHAPE_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    const from = signInOf(user);
    try {
      await finishAuthenticatorSetup(user, setup, digits, authenticatorName(existingCount));
      onEnrolled();
    } catch (failure) {
      const failed = errorCode(failure);
      if (enrolNeedsFreshSignIn(failed)) {
        onNeedsSignIn(from);
        return;
      }
      setCode('');
      setError(enrolErrorMessage(failed));
      if (secondStepExpired(failed)) setExpired(true);
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'add' ? 'Add an authenticator app' : 'Set up your second sign-in step';
  return (
    <FocusedPanel title={title}>
      {wasReset ? (
        <p role="status" className="rounded-md border border-foreground/40 p-3 font-medium">
          Your second sign-in step was reset. Set it up again to continue. If you did not ask for this, tell DryScope
          support.
        </p>
      ) : null}
      {mode === 'required' ? (
        <p>
          Your role needs an authenticator app as a second step every time you sign in to {companyName}. You cannot use
          DryScope until it is set up.
        </p>
      ) : existingCount > 0 ? (
        <p>Add another authenticator app, for example on a second phone, so losing one does not lock you out.</p>
      ) : (
        <p>
          Turn on a second sign-in step: each time you sign in to {companyName}, you also enter a code from an
          authenticator app.
        </p>
      )}
      {setup ? (
        <>
          <ol className="flex list-decimal flex-col gap-3 pl-5">
            <li>Open an authenticator app on your phone.</li>
            <li>
              Scan this QR code with it.
              <div className="mt-3 flex flex-col gap-3">
                <QrCode text={setup.uri} label="QR code for your authenticator app" />
              </div>
            </li>
            <li>
              Or add it by typing this key:
              <p className="mt-2 break-words rounded-md border border-foreground/40 p-3 font-mono text-lg select-all" data-testid="setup-key">
                {groupedKey(setup.key)}
              </p>
            </li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="second-step-enrol-code" className="font-medium">
                6-digit code
              </label>
              <Input
                id="second-step-enrol-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={7}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
              {error ?? ''}
            </p>
            <Button type="submit" disabled={busy || expired}>
              Turn on second step
            </Button>
          </form>
        </>
      ) : (
        <>
          {/* One live status at a time: while the reset notice above is the status, the loading line
              is plain text, so a screen reader hears one message, not two. */}
          <p
            role={error ? 'alert' : wasReset ? undefined : 'status'}
            className={error ? 'text-sm font-medium text-red-800' : undefined}
          >
            {error ?? 'Getting your setup key…'}
          </p>
        </>
      )}
      {expired ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={onStartAgain}
        >
          Start again
        </Button>
      ) : null}
      <Button variant="outline" disabled={busy} onClick={onLeave}>
        {mode === 'required' ? 'Sign out' : 'Back'}
      </Button>
    </FocusedPanel>
  );
}
