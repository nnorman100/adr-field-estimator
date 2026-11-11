'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { completeSecondStepSignIn, type SecondStepChallenge } from '@/lib/firebase-client';
import { errorCode } from '@/lib/sign-in/outcome';
import { CODE_SHAPE_MESSAGE, codeErrorMessage, normalizeCode, secondStepExpired } from '@/lib/sign-in/second-step';
import { FocusedPanel } from '../focused-panel';

export type CodeScreenProps = {
  challenge: SecondStepChallenge;
  // The code was right: the person is signed in (the page's sign-in listener takes over).
  onVerified: (uid: string) => void;
  // The pending sign-in ran out, so the person signs in again from the start.
  onExpired: () => void;
  // The person chose to go back to the sign-in form.
  onBack: () => void;
};

// Entering the authenticator app's code at sign-in (S3-14). Until the code is right nobody is
// signed in: Identity Platform returns no session for the password alone.
export function CodeScreen({ challenge, onVerified, onExpired, onBack }: CodeScreenProps) {
  const [factorId, setFactorId] = useState(challenge.factors[0]!.id);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const digits = normalizeCode(code);
    if (digits === null) {
      setError(CODE_SHAPE_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { uid } = await completeSecondStepSignIn(challenge, factorId, digits);
      onVerified(uid);
    } catch (failure) {
      const failed = errorCode(failure);
      if (secondStepExpired(failed)) {
        onExpired();
        return;
      }
      setCode('');
      setError(codeErrorMessage(failed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FocusedPanel title="Enter your sign-in code">
      <p>Open your authenticator app and enter the 6-digit code it shows for DryScope.</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {challenge.factors.length > 1 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">Which authenticator app?</legend>
            {challenge.factors.map((factor) => (
              <label key={factor.id} className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name="second-step-factor"
                  className="size-5"
                  checked={factorId === factor.id}
                  onChange={() => setFactorId(factor.id)}
                />
                {factor.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor="second-step-code" className="font-medium">
            6-digit code
          </label>
          <Input
            id="second-step-code"
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
        <Button type="submit" disabled={busy}>
          Sign in
        </Button>
      </form>
      <Button variant="outline" disabled={busy} onClick={onBack}>
        Back to sign in
      </Button>
    </FocusedPanel>
  );
}
