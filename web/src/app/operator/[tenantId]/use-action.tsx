'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiResult } from '@/lib/operator/client';
import { isSignInAgainCode, operatorErrorMessage } from '@/lib/operator/screens';
import { useOperator } from './operator-session';
import { ErrorMessage } from './ui';

// One operator action: runs a call, keeps the button busy, and turns a refusal into words. A
// refusal that needs a new sign-in (a team or second-step change after 15 minutes) offers it.
export function useAction() {
  const { signInAgain } = useOperator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function run<T>(request: () => Promise<ApiResult<T>>, onDone: (body: T) => void | Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      const result = await request();
      if (result.ok) {
        await onDone(result.body);
      } else if (isSignInAgainCode(result.code)) {
        setStale(true);
        setError('For that change, sign in again.');
      } else {
        setError(operatorErrorMessage(result.code));
      }
    } finally {
      setBusy(false);
    }
  }

  const problem = (
    <>
      <ErrorMessage text={error} />
      {stale ? (
        <Button variant="outline" onClick={() => void signInAgain()}>
          Sign in again
        </Button>
      ) : null}
    </>
  );

  return { busy, run, problem, clear: () => setError(null) };
}
