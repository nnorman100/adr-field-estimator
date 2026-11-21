'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { applyWaitingWorker, NO_WORKER, watchFieldWorker, type WorkerState } from '@/lib/field/register-worker';
import { forgetKept, keepForUpdate } from '@/lib/field/update-keep';
import { pending } from '@/lib/field/pending';
import { holdsWindow, whileNoFieldWindow } from '@/lib/field/window-lock';
import { subscribeToUpdate, updateBusy, updateRequired } from '@/lib/update-activity';

const BUSY_TEXT = {
  camera: 'Close the camera before updating.',
  save: 'Wait for the save to finish.',
  upload: 'Wait for the upload to finish.',
};

// The homeowner's signing page and the adjuster's documents page: a person who is not the
// technician, who never gets the field app installed or an update banner from a visit.
const PUBLIC_PAGES = ['/sign', '/documents'];
export const publicPage = (pathname: string | null): boolean => PUBLIC_PAGES.some((page) => pathname === page || pathname?.startsWith(`${page}/`));

// How long a reload that did not leave the page is waited for: the person stayed on the browser's
// leave-this-page prompt.
const RELOAD_WAIT_MS = 2000;

export function AppUpdate({ children }: { children: ReactNode }) {
  return publicPage(usePathname()) ? <>{children}</> : <UpdateWatch>{children}</UpdateWatch>;
}

function UpdateWatch({ children }: { children: ReactNode }) {
  const busy = useSyncExternalStore(subscribeToUpdate, updateBusy, () => null);
  const needed = useSyncExternalStore(subscribeToUpdate, updateRequired, () => false);
  const [worker, setWorker] = useState<WorkerState>(NO_WORKER);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const starting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { waiting, replaced, unsupported } = worker;
  const ready = waiting !== null || replaced;

  useEffect(() => watchFieldWorker(setWorker), []);
  useEffect(() => {
    if (!needed) return;
    heading.current?.focus();
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
    }
  }, [needed]);

  const reason = busy ? BUSY_TEXT[busy] : '';
  const canUpdate = ready || (needed && unsupported);
  const apply = useCallback(async () => {
    if (starting.current || updateBusy() || !canUpdate) return;
    starting.current = true;
    setApplying(true);
    setError('');
    let owner: string | null = null;
    try {
      const activate = async (): Promise<boolean | 'elsewhere' | 'not-kept'> => {
        if (updateBusy()) return false;
        owner = pending.kept()?.owner ?? null;
        if (!(await keepForUpdate())) return 'not-kept';
        if (updateBusy()) return false;
        return waiting && !replaced ? applyWaitingWorker(waiting) : true;
      };
      const updated = replaced || unsupported || holdsWindow() ? await activate() : await whileNoFieldWindow(activate);
      if (updated === true) {
        const stay = window.setTimeout(giveUp, RELOAD_WAIT_MS);
        window.addEventListener('pagehide', () => window.clearTimeout(stay), { once: true });
        window.location.reload();
        return;
      }
      setError(
        updated === 'elsewhere'
          ? 'Close the other DryScope window and try again.'
          : updated === 'not-kept'
            ? 'This phone could not keep your unsent work for the update. Keep this window open and try again.'
            : 'Could not apply the update. Try again.',
      );
    } catch {
      setError('Could not apply the update. Try again.');
    }
    await release();

    function giveUp() {
      setError('The update did not start. Try again.');
      void release();
    }
    async function release() {
      if (owner) await forgetKept(owner).catch(() => undefined);
      starting.current = false;
      setApplying(false);
    }
  }, [canUpdate, replaced, unsupported, waiting]);

  useEffect(() => {
    // Another window accepted the update. Once this window is safe, reload it into the same build.
    if (!replaced || busy || applying || error) return;
    let live = true;
    queueMicrotask(() => {
      if (live) void apply();
    });
    return () => { live = false; };
  }, [apply, applying, busy, error, replaced]);

  const status = reason || (applying ? 'Applying the update…' : !canUpdate ? 'Waiting for the update to download…' : error);
  const button = (
    <>
      <Button type="button" disabled={Boolean(reason) || applying || !canUpdate} aria-describedby="app-update-status" onClick={() => void apply()}>
        Update now
      </Button>
      <p id="app-update-status" role="status" className="text-sm">
        {status}
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
      ) : ready || applying ? (
        <section aria-label="Update ready" className="mx-auto flex max-w-md flex-wrap items-center gap-3 border-b border-foreground/20 px-6 py-3">
          <p className="mr-auto font-medium">Update ready</p>
          {button}
        </section>
      ) : null}
      <div inert={needed || applying}>{children}</div>
    </>
  );
}
