'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { applyWaitingWorker, NO_WORKER, watchFieldWorker, type WorkerState } from '@/lib/field/register-worker';
import { forgetKept, keepBlock, keepForUpdate } from '@/lib/field/update-keep';
import { pending, usePending } from '@/lib/field/pending';
import { holdsWindow, whileNoFieldWindow } from '@/lib/field/window-lock';
import { hasHeldUpdatePeer, holdUpdateWindow, subscribeToUpdate, updateBusy, updateRequired, whileActivatingUpdate } from '@/lib/update-activity';

const BUSY_TEXT = {
  camera: 'Close the camera before updating.',
  save: 'Wait for the save to finish.',
  upload: 'Wait for the upload to finish.',
  unsent: 'Save, send or discard your unsent changes before updating.',
};

// The homeowner's signing page and the adjuster's documents page: a person who is not the
// technician, who never gets the field app installed or an update banner from a visit.
const PUBLIC_PAGES = ['/sign', '/documents'];
export const publicPage = (pathname: string | null): boolean => PUBLIC_PAGES.some((page) => pathname === page || pathname?.startsWith(`${page}/`));

// How long a reload that did not leave the page is waited for: the person stayed on the browser's
// leave-this-page prompt.
const RELOAD_WAIT_MS = 2000;
const PEER_CHECK_MS = 500;
const PEER_TEXT = 'Another window has unsaved work.';

export function AppUpdate({ children }: { children: ReactNode }) {
  return publicPage(usePathname()) ? <>{children}</> : <UpdateWatch>{children}</UpdateWatch>;
}

function UpdateWatch({ children }: { children: ReactNode }) {
  const busy = useSyncExternalStore(subscribeToUpdate, updateBusy, () => null);
  const needed = useSyncExternalStore(subscribeToUpdate, updateRequired, () => false);
  const kept = usePending(keepBlock);
  const hasPendingWork = usePending(() => pending.kept() !== null);
  const [worker, setWorker] = useState<WorkerState>(NO_WORKER);
  const [peerHeld, setPeerHeld] = useState<boolean | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const starting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { waiting, replaced, active, unsupported } = worker;
  const ready = waiting !== null || replaced;
  const waitingUpdate = replaced ? null : waiting;

  useEffect(() => watchFieldWorker(setWorker), []);
  useEffect(() => (hasPendingWork ? holdUpdateWindow() : undefined), [hasPendingWork]);
  useEffect(() => {
    if (!waitingUpdate) return;
    let live = true;
    let timer: number | undefined;
    const check = async () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      const held = await hasHeldUpdatePeer();
      if (!live) return;
      setPeerHeld(held);
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible') timer = window.setTimeout(() => void check(), PEER_CHECK_MS);
    };
    document.addEventListener('visibilitychange', check);
    void check();
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [waitingUpdate]);
  useEffect(() => {
    if (!needed) return;
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
    }
  }, [needed]);

  const reason = busy ? BUSY_TEXT[busy] : (kept ?? (waitingUpdate && peerHeld ? PEER_TEXT : ''));
  // Work only this window holds stays reachable while the update waits for it: nothing covers it.
  const covering = needed && busy !== 'unsent' && kept === null;
  const canUpdate = (ready || (needed && (unsupported || active))) && (!waitingUpdate || peerHeld !== null);
  useEffect(() => {
    if (covering) heading.current?.focus();
  }, [covering]);
  const apply = useCallback(async () => {
    if (starting.current || updateBusy() || keepBlock() || !canUpdate) return;
    starting.current = true;
    setApplying(true);
    setError('');
    // The row this tap wrote, if any: an earlier one that was not put back yet is never removed here.
    let owner: string | null = null;
    try {
      const activate = async (): Promise<boolean | 'peer-held' | 'not-kept'> => {
        if (updateBusy()) return false;
        const carrying = pending.kept()?.owner ?? null;
        if (!(await keepForUpdate())) return 'not-kept';
        owner = carrying;
        if (!waitingUpdate) return !updateBusy();
        // The peer may have started work since the banner last checked, and may not start more
        // until the worker has switched.
        const applied = await whileActivatingUpdate(async () => (updateBusy() ? false : applyWaitingWorker(waitingUpdate)));
        if (applied === 'peer-held') setPeerHeld(true);
        return applied;
      };
      const updated = replaced || unsupported || holdsWindow() ? await activate() : await whileNoFieldWindow(activate);
      if (updated === true) {
        // What was kept stays until the new page puts it back, however slowly it loads: after this
        // wait the person may only try again.
        const stay = window.setTimeout(offerAgain, RELOAD_WAIT_MS);
        window.addEventListener('pagehide', () => window.clearTimeout(stay), { once: true });
        window.location.reload();
        return;
      }
      if (updated !== 'peer-held') setError(
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

    function offerAgain() {
      setError('The update did not start. Try again.');
      settle();
    }
    function settle() {
      starting.current = false;
      setApplying(false);
    }
    async function release() {
      if (owner) await forgetKept(owner).catch(() => undefined);
      settle();
    }
  }, [canUpdate, replaced, unsupported, waitingUpdate]);

  useEffect(() => {
    // Another window accepted the update. Once this window is safe, reload it into the same build.
    if (!replaced || reason || hasPendingWork || applying || error) return;
    let live = true;
    queueMicrotask(() => {
      if (live) void apply();
    });
    return () => { live = false; };
  }, [apply, applying, error, hasPendingWork, reason, replaced]);

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
      {covering ? (
        <section role="dialog" aria-modal="true" aria-labelledby="app-update-title" className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-background px-6">
          <div className="flex w-full max-w-sm flex-col gap-4">
            <h1 ref={heading} id="app-update-title" tabIndex={-1} className="text-2xl font-semibold">Update needed</h1>
            <p>Get the latest version to send changes to DryScope.</p>
            {button}
          </div>
        </section>
      ) : needed || ready || applying ? (
        <section aria-label={needed ? 'Update needed' : 'Update ready'} className="mx-auto flex max-w-md flex-wrap items-center gap-3 border-b border-foreground/20 px-6 py-3">
          <p className="mr-auto font-medium">{needed ? 'Update needed to send your changes' : 'Update ready'}</p>
          {button}
        </section>
      ) : null}
      <div inert={covering || applying}>{children}</div>
    </>
  );
}
