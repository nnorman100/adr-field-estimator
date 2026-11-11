'use client';

import type { User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authenticatorCount } from '@/lib/firebase-client';

// On the signed-in screen: whether a second sign-in step is on, and a way to add an authenticator
// app (S3-14). Owners must have one; office and estimators may turn it on for themselves (owner
// decision D2), so every role sees this. The count is read from Firebase; when it cannot be read
// the button is still offered.
export function SecondStepSection({ user, onAdd }: { user: User; onAdd: (existing: number) => void }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    void authenticatorCount(user).then((found) => {
      if (current) setCount(found);
    });
    return () => {
      current = false;
    };
  }, [user]);

  const status =
    count === null
      ? null
      : count === 0
        ? 'Second sign-in step: off.'
        : `Second sign-in step: on, with ${count === 1 ? '1 authenticator app' : `${count} authenticator apps`}.`;
  return (
    <section aria-label="Second sign-in step" className="flex flex-col gap-3">
      {status ? <p>{status}</p> : null}
      <Button variant="outline" onClick={() => onAdd(count ?? 0)}>
        {count !== null && count > 0 ? 'Add another authenticator app' : 'Add an authenticator app'}
      </Button>
    </section>
  );
}
