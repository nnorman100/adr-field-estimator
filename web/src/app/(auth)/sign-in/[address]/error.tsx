'use client';

import ErrorPage from '@/app/error';
import { Panel } from '../../panel';
import { SIGN_IN_BUSY } from './busy';

// The error boundary of a company sign-in page and every screen under its address: a lookup that
// found no free database connection in time (load.ts) says so on the same address, with nothing
// else to do but try again; anything else is the app's own error page.
export default function SignInError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  if (error.digest !== SIGN_IN_BUSY) return <ErrorPage error={error} reset={reset} />;
  return (
    <Panel title="DryScope is busy">
      <p>Try again shortly.</p>
    </Panel>
  );
}
