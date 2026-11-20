'use client';

import { useReachable } from '@/app/field/connection';

// The support views read from the server on every opening, so they work only with a connection
// (S5 is online only, and says so on screen). While the phone cannot reach the app, a status line
// says it.
export function ConnectionNotice() {
  const online = useReachable();
  return (
    <>
      <p className="text-sm">These views need a connection.</p>
      {!online ? <p role="status">Needs a connection</p> : null}
    </>
  );
}
