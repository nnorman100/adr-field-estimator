'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FocusedPanel } from '../../focused-panel';

// A sign-out the app had to make could not first save the refusal on this phone (S6-3b): nothing
// was signed out or removed, nothing of the company shows, and "Try again" makes that same sign-out
// again (signOutOrShow in src/lib/field/sign-out.ts), so the refusal is saved before anything else
// can open.
export const NOT_SECURED_TITLE = 'We couldn’t secure your saved work';
export const NOT_SECURED_TEXT = 'This phone could not save what keeps your unsent work safe. Nothing was removed. Try again.';

export function WorkNotSecured({ retry }: { retry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <FocusedPanel title={NOT_SECURED_TITLE}>
      <p>{NOT_SECURED_TEXT}</p>
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void retry().finally(() => setBusy(false));
        }}
      >
        Try again
      </Button>
    </FocusedPanel>
  );
}
