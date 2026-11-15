'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { QrCode } from '@/app/(auth)/second-step/qr-code';
import { Button } from '@/components/ui/button';

// A link the technician sends from their own phone (S5a-11b): shown once, with Copy (the Async
// Clipboard API), Share (the phone's share sheet, where the browser has one) and a QR code drawn in
// the browser, so the token never goes to an image service. DryScope itself sends no email or text
// message (J7). The confirmation is a live region beside the buttons, for copy failures too, and the
// buttons stay enabled: copying again is harmless.
const noChange = () => () => {};
const hasShareSheet = () => typeof navigator.share === 'function';

export function ShareLink({ address, label, shareTitle }: { address: string; label: string; shareTitle: string }) {
  const fieldId = useId();
  const [said, setSaid] = useState('');
  // Whether this browser has a share sheet; never on the server's render.
  const canShare = useSyncExternalStore(noChange, hasShareSheet, () => false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function say(message: string) {
    if (timer.current) clearTimeout(timer.current);
    setSaid('');
    requestAnimationFrame(() => setSaid(message));
    timer.current = setTimeout(() => setSaid(''), 4000);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      say('Link copied.');
    } catch {
      say('The link could not be copied. Select it above and copy it.');
    }
  }

  async function share() {
    try {
      await navigator.share({ title: shareTitle, url: address });
    } catch (error) {
      // Closing the share sheet is not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) say('The share sheet could not open. Copy the link instead.');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={fieldId} className="font-semibold">
        {label}
      </label>
      <input
        id={fieldId}
        readOnly
        value={address}
        onFocus={(event) => event.currentTarget.select()}
        className="w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void copy()}>
          Copy link
        </Button>
        {canShare ? (
          <Button type="button" variant="outline" onClick={() => void share()}>
            Share
          </Button>
        ) : null}
      </div>
      <p role="status" className="min-h-5 text-sm">
        {said}
      </p>
      <QrCode text={address} label={`QR code of the ${label.toLowerCase()}`} />
      <p className="text-sm">The link is shown only now. Send it from your phone by text message or email, or let the customer scan the code.</p>
    </div>
  );
}
