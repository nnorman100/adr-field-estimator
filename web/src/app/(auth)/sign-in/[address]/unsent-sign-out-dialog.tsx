'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

// "Sign out" with edits on this phone that the server does not have yet (S6-3): keep them, and they
// are sent when this person signs in here again (D7), or discard them. Only this person's work in
// this company is meant; another company's or another person's is never touched. A native modal
// dialog (the modern-web-guidance "dialog" rules): Keep has the focus, being the safe choice; Esc and
// the back gesture close it without choosing.

export const UNSENT_TITLE = 'Work not sent yet';
export const KEEP_LABEL = 'Keep it and sign out';
export const DISCARD_LABEL = 'Discard it and sign out';

export type UnsentChoice = 'keep' | 'discard';

export function UnsentSignOutDialog({
  open,
  companyName,
  onChoice,
}: {
  open: boolean;
  companyName: string;
  onChoice: (choice: UnsentChoice | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="unsent-title"
      aria-describedby="unsent-text"
      onClose={(event) => {
        const value = event.currentTarget.returnValue;
        event.currentTarget.returnValue = '';
        onChoice(value === 'keep' || value === 'discard' ? value : null);
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md overscroll-contain rounded-2xl border border-input bg-background p-6 text-foreground backdrop:bg-black/40"
    >
      <h2 id="unsent-title" className="text-xl font-semibold">
        {UNSENT_TITLE}
      </h2>
      <p id="unsent-text" className="mt-3 text-base">
        Some of your changes to {companyName} jobs are saved on this phone but have not reached DryScope yet. If you
        keep them, they are sent when you sign in on this phone again. If you discard them, they are gone for good.
      </p>
      <form method="dialog" className="mt-4 flex flex-col gap-2">
        <Button autoFocus value="keep">
          {KEEP_LABEL}
        </Button>
        <Button variant="outline" value="discard">
          {DISCARD_LABEL}
        </Button>
        <Button variant="outline" value="">
          Cancel
        </Button>
      </form>
    </dialog>
  );
}
