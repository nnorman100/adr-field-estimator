'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { readFieldSurface, type FieldSurface } from '@/lib/field/platform';
import {
  HOME_SCREEN_HELP,
  HOME_SCREEN_NOTICE,
  HOME_SCREEN_STEPS,
  HOME_SCREEN_TITLE,
  HOME_SCREEN_WHY,
} from './home-screen-text';

// The "Save DryScope to your Home Screen" sheet (S6-2, as corrected by owner decision G8, D-025:
// docs/plans/S6.md section 12). On an iPhone, Safari deletes a website's stored data, unsent offline
// photos and notes included, after about 7 days without a visit, and a Home Screen website keeps its
// own storage that is exempt (section 2). So in an iPhone browser tab the field screens work online
// only, and this sheet explains the way out in plain steps. It opens by itself once per phone, then
// from its button; the notice and button stay on the page until DryScope runs from the icon.
// It is only ever shown in an iPhone or iPad tab: the steps are Safari's, and Android and computers
// are not limited (platform.ts).
const SEEN_KEY = 'dryscope.homeScreenSheetSeen';

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

function watchSurface(onChange: () => void): () => void {
  const media = window.matchMedia('(display-mode: standalone)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

// Where the page is running: null while it is built on the server and on the first client render,
// so the two agree, and then the same string every time until the phone's display mode changes.
export function useFieldSurface(): FieldSurface | null {
  return useSyncExternalStore(watchSurface, readFieldSurface, () => null);
}

export function HomeScreenSheet({ openFirstTime }: { openFirstTime: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (openFirstTime && !seen()) dialog.current?.showModal();
  }, [openFirstTime]);
  return (
    <>
      <p className="text-base">{HOME_SCREEN_NOTICE}</p>
      <Button variant="outline" onClick={() => dialog.current?.showModal()}>
        {HOME_SCREEN_TITLE}
      </Button>
      <dialog
        ref={dialog}
        // Light dismiss where the browser has it; Esc and the back gesture close it everywhere.
        closedby="any"
        aria-labelledby="home-screen-title"
        onClose={markSeen}
        className="m-0 mt-auto w-full max-w-none rounded-t-2xl border border-input bg-background p-6 text-foreground backdrop:bg-black/40"
      >
        <h2 id="home-screen-title" className="text-xl font-semibold">
          {HOME_SCREEN_TITLE}
        </h2>
        <p className="mt-3 text-base">{HOME_SCREEN_WHY}</p>
        <ol className="my-4 list-decimal space-y-2 pl-6 text-base">
          {HOME_SCREEN_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="mb-4 text-base">{HOME_SCREEN_HELP}</p>
        <form method="dialog">
          <Button autoFocus className="w-full">
            Got it
          </Button>
        </form>
      </dialog>
    </>
  );
}
