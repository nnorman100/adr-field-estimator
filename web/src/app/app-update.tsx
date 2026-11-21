'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { pending, usePending } from '@/lib/field/pending';
import { applyWaitingWorker, watchFieldWorker } from '@/lib/field/register-worker';
import { holdsWindow, whileNoFieldWindow } from '@/lib/field/window-lock';
import { subscribeToUpdate, updateBusy, updateRequired } from '@/lib/update-activity';

const BUSY_TEXT = {
  camera: 'Close the camera before updating.',
  save: 'Wait for the save to finish.',
  upload: 'Wait for the upload to finish.',
};

export function AppUpdate({ children }: { children: ReactNode }) {
  const busy = useSyncExternalStore(subscribeToUpdate, updateBusy, () => null);
  const needed = useSyncExternalStore(subscribeToUpdate, updateRequired, () => false);
  const photos = usePending(pending.hasPhotos);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const starting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => watchFieldWorker(setWaiting), []);
  useEffect(() => {
    if (!needed) return;
    heading.current?.focus();
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
    }
  }, [needed]);

  const heldPhotos = needed
    ? 'A photo is still held in this window. Keep it open to avoid losing the photo.'
    : 'Send the photos kept in this window before updating.';
  const reason = busy ? BUSY_TEXT[busy] : photos ? heldPhotos : '';
  async function apply() {
    if (starting.current || updateBusy() || pending.hasPhotos() || !waiting) return;
    starting.current = true;
    setApplying(true);
    setError('');
    const activate = () => updateBusy() || pending.hasPhotos() ? Promise.resolve(false) : applyWaitingWorker(waiting);
    try {
      const updated = holdsWindow() ? await activate() : await whileNoFieldWindow(activate);
      if (updated === true) {
        window.location.reload();
        return;
      }
      setError(updated === 'elsewhere' ? 'Close the other DryScope window and try again.' : 'Could not apply the update. Try again.');
    } catch {
      setError('Could not apply the update. Try again.');
    }
    starting.current = false;
    setApplying(false);
  }

  const button = (
    <>
      <Button type="button" disabled={Boolean(reason) || applying || !waiting} aria-describedby="app-update-status" onClick={() => void apply()}>
        Update now
      </Button>
      <p id="app-update-status" role="status" className="text-sm">
        {reason || (applying ? 'Applying the update…' : !waiting ? 'Waiting for the update to download…' : error)}
      </p>
    </>
  );
  return (
    <>
      {needed ? (
        <section role="dialog" aria-modal="true" aria-labelledby="app-update-title" className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-background px-6">
          <div className="flex w-full max-w-sm flex-col gap-4">
            <h1 ref={heading} id="app-update-title" tabIndex={-1} className="text-2xl font-semibold">Update needed</h1>
            <p>Get the latest version to send changes to DryScope.</p>
            {button}
          </div>
        </section>
      ) : waiting || applying ? (
        <section aria-label="Update ready" className="mx-auto flex max-w-md flex-wrap items-center gap-3 border-b border-foreground/20 px-6 py-3">
          <p className="mr-auto font-medium">Update ready</p>
          {button}
        </section>
      ) : null}
      <div inert={needed || applying}>{children}</div>
    </>
  );
}
