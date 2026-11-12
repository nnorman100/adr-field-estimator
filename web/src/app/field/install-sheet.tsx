'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';

// The "Install to your Home Screen" sheet (S6-2, owner decision O1: ask, do not require).
//
// A phone's browser tab and its installed Home Screen app keep separate storage, and Safari
// deletes a tab's stored data after 7 days without use (docs/plans/S6.md section 2), so the app
// asks at the start. It opens by itself once per phone, then only from the button.
const SEEN_KEY = 'dryscope.installSheetSeen';

export const INSTALL_TITLE = 'Install to your Home Screen';
export const INSTALL_HELP =
  'Install before you start a job. The installed app keeps its own saved data, so installing later starts empty and signed out.';

export function isInstalled(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function seen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Asked again next time; nothing else depends on it.
  }
}

function watchInstalled(onChange: () => void): () => void {
  const media = window.matchMedia('(display-mode: standalone)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

// True in a browser tab, false in the installed app, and null while the page is built on the server
// and on the first client render, so the two agree.
export function useInstallable(): boolean | null {
  return useSyncExternalStore(watchInstalled, () => !isInstalled(), () => null);
}

export function InstallSheet({ openFirstTime }: { openFirstTime: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (openFirstTime && !seen()) dialog.current?.showModal();
  }, [openFirstTime]);
  return (
    <>
      <Button variant="outline" onClick={() => dialog.current?.showModal()}>
        {INSTALL_TITLE}
      </Button>
      <dialog
        ref={dialog}
        // Light dismiss where the browser has it; Esc and the back gesture close it everywhere.
        closedby="any"
        aria-labelledby="install-title"
        onClose={markSeen}
        className="m-0 mt-auto w-full max-w-none rounded-t-2xl border border-input bg-background p-6 text-foreground backdrop:bg-black/40"
      >
        <h2 id="install-title" className="text-xl font-semibold">
          {INSTALL_TITLE}
        </h2>
        <ol className="my-4 list-decimal space-y-2 pl-6 text-base">
          <li>Tap the Share button in the Safari toolbar (the square with an arrow pointing up).</li>
          <li>Scroll down and tap Add to Home Screen.</li>
          <li>Tap Add, then open DryScope from the new icon.</li>
        </ol>
        <p className="mb-4 text-base">{INSTALL_HELP}</p>
        <form method="dialog">
          <Button autoFocus className="w-full">
            Got it
          </Button>
        </form>
      </dialog>
    </>
  );
}
