'use client';

import { useEffect, useState } from 'react';
import { readLatestMe, type DsMe } from '@/lib/field/ds-me';
import { registerFieldWorker } from '@/lib/field/register-worker';
import { offlineCaptureAllowed } from '@/lib/field/platform';
import { rememberedSignInAddress } from '@/lib/sign-in/remember';
import { NotSavedBanner, OfflineBanner } from './banners';
import { useReachable } from './connection';
import { HomeScreenSheet, useFieldSurface } from './home-screen-sheet';

// The field shell (S6-2): the one page every field screen lives in. The server renders nothing of
// a person's here, so the page is built once, the service worker keeps that copy, and the Home
// Screen icon opens it with no signal. It starts from `ds-me` (the settings and company saved at
// the last online sign-in), never from the server, and all views under it are client state. The
// job screens (S5a-6) and the phone's stores (S6-3 and after) mount in the slot below.
type Boot =
  | { kind: 'starting' }
  | { kind: 'ready'; me: DsMe }
  // Nothing saved on this phone yet: the first visit needs a connection and a sign-in.
  | { kind: 'signed-out'; address: string | null }
  // The phone's storage cannot be opened at all.
  | { kind: 'no-storage'; address: string | null };

export function FieldShell() {
  const [boot, setBoot] = useState<Boot>({ kind: 'starting' });
  const reachable = useReachable();
  const surface = useFieldSurface();

  useEffect(() => {
    registerFieldWorker();
    let live = true;
    const load = () =>
      void readLatestMe().then((me) => {
        if (!live) return;
        const address = rememberedSignInAddress();
        if (me === 'unavailable') setBoot({ kind: 'no-storage', address });
        else if (me === null) setBoot({ kind: 'signed-out', address });
        else setBoot({ kind: 'ready', me });
      });
    // A page brought back from the back-forward cache keeps its old state; the phone may have
    // signed out since.
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) load();
    };
    load();
    window.addEventListener('pageshow', restored);
    return () => {
      live = false;
      window.removeEventListener('pageshow', restored);
    };
  }, []);

  return (
    <div
      className="mx-auto flex min-h-dvh max-w-md flex-col"
      data-shell="field"
      // Capture screens (S5a-6, S6-5) must ask offlineCaptureAllowed, never decide for themselves.
      data-offline-capture={offlineCaptureAllowed(surface) ? 'allowed' : 'blocked'}
    >
      <OfflineBanner
        offline={!reachable && (boot.kind === 'ready' || boot.kind === 'signed-out')}
        onlineOnly={surface === 'ios-tab'}
      />
      <NotSavedBanner unavailable={boot.kind === 'no-storage'} />
      <main className="flex flex-1 flex-col gap-4 p-6">
        <p className="text-sm font-semibold tracking-wide">DryScope</p>
        {boot.kind === 'starting' ? <p role="status">Opening…</p> : null}
        {boot.kind === 'ready' ? (
          <>
            <h1 className="text-2xl font-semibold">{boot.me.companyName}</h1>
            <p className="text-base">Your jobs will show here.</p>
          </>
        ) : null}
        {boot.kind === 'signed-out' || boot.kind === 'no-storage' ? (
          <>
            <h1 className="text-2xl font-semibold">Sign in to continue</h1>
            <p className="text-base">
              The first time on this phone needs a connection. Open your company&rsquo;s sign-in link and sign in; after
              that this screen opens with no signal.
            </p>
            {boot.address ? (
              <a className="text-base font-medium underline" href={`/sign-in/${boot.address}`}>
                Go to sign in
              </a>
            ) : null}
          </>
        ) : null}
        {surface === 'ios-tab' ? <HomeScreenSheet openFirstTime={boot.kind !== 'starting'} /> : null}
      </main>
    </div>
  );
}
