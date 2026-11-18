'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { meKey, readLatestMe, type DsMe } from '@/lib/field/ds-me';
import { registerFieldWorker } from '@/lib/field/register-worker';
import { watchRetention } from '@/lib/field/retention';
import { offlineCaptureAllowed } from '@/lib/field/platform';
import { rememberedSignInAddress } from '@/lib/sign-in/remember';
import { NotSavedBanner, OfflineBanner } from './banners';
import { FieldApp } from './field-app';
import { useReachable } from './connection';
import { FieldStore, UnlessHidden, type FieldStorage } from './field-store';
import { REOPEN_STORAGE_TEXT, REOPEN_TITLE } from './field-store-text';
import { HomeScreenSheet, useFieldSurface } from './home-screen-sheet';
import { SyncChip } from './sync-chip';

// The field shell (S6-2): the one page every field screen lives in. The server renders nothing of
// a person's here, so the page is built once, the service worker keeps that copy, and the Home
// Screen icon opens it with no signal. It starts from `ds-me` (the settings and company saved at
// the last online sign-in), never from the server, and all views under it are client state. The
// phone's Firestore cache and sync gate (S6-3, ./field-store.tsx) start below it, and the job
// screens (S5a-6, ./field-app.tsx) mount inside that store and use its person-scoped client.
type Boot =
  | { kind: 'starting' }
  | { kind: 'ready'; me: DsMe }
  // Nothing saved on this phone yet: the first visit needs a connection and a sign-in.
  | { kind: 'signed-out'; address: string | null }
  // The phone's storage cannot be opened at all.
  | { kind: 'no-storage'; address: string | null }
  // The phone's storage lost its connection twice (src/lib/field/idb.ts).
  | { kind: 'reopen' };

// The job screens ask the server who the person is as soon as they mount. A shell opened in a
// page that is not shown (a background tab, a phone that restored it hidden) must ask nothing until
// it is (S6-3: the sync gate waits the same way), so they mount once the page has been shown, and
// then stay.
function ShownOnce({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    if (shown) return;
    const onChange = () => {
      if (document.visibilityState === 'visible') setShown(true);
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [shown]);
  return shown ? <>{children}</> : null;
}

export function FieldShell() {
  const [boot, setBoot] = useState<Boot>({ kind: 'starting' });
  // What the Firestore cache keeps (S6-3). A fallback to memory keeps nothing, as with no storage at
  // all; Online only keeps nothing by choice.
  const [storage, setStorage] = useState<FieldStorage>('kept');
  const reachable = useReachable();
  const surface = useFieldSurface();

  useEffect(() => {
    registerFieldWorker();
    let live = true;
    const load = () =>
      void readLatestMe().then((me) => {
        if (!live) return;
        const address = rememberedSignInAddress();
        if (me === 'reopen') setBoot({ kind: 'reopen' });
        else if (me === 'unavailable') setBoot({ kind: 'no-storage', address });
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

  // The phone's retention routine (O5, S6-3b; retention.ts) runs as the shell opens and each time it
  // is shown again, whatever the shell then shows: signed in or not, the question about keeping
  // jobs answered or not, a field client started or not. It covers everyone on the phone, this
  // person included, and removes nothing (decision 010).
  useEffect(() => watchRetention(), []);

  const homeScreen = surface === 'ios-tab' ? <HomeScreenSheet openFirstTime={boot.kind !== 'starting'} /> : null;

  return (
    <div
      className="mx-auto flex min-h-dvh max-w-md flex-col"
      data-shell="field"
      // Capture screens (S5a-6, S6-5) must ask offlineCaptureAllowed, never decide for themselves.
      data-offline-capture={offlineCaptureAllowed(surface) ? 'allowed' : 'blocked'}
    >
      <OfflineBanner
        offline={!reachable && storage !== 'not-saved' && (boot.kind === 'ready' || boot.kind === 'signed-out')}
        onlineOnly={surface === 'ios-tab'}
        kept={storage === 'kept'}
      />
      <NotSavedBanner unavailable={boot.kind === 'no-storage' || storage === 'not-saved'} />
      <main className="flex flex-1 flex-col gap-4 p-6">
        <p className="text-sm font-semibold tracking-wide">DryScope</p>
        {boot.kind === 'starting' ? <p role="status">Opening…</p> : null}
        {boot.kind === 'ready' ? (
          <>
            <h1 className="text-2xl font-semibold">{boot.me.companyName}</h1>
            {/* Above the content that loads after the page shows, so nothing moves the notice. */}
            {homeScreen}
            <FieldStore
              key={`${boot.me.tenantId}/${boot.me.uid}`}
              me={boot.me}
              surface={surface}
              reachable={reachable}
              onStorage={setStorage}
            >
              {/* The view is read from the address, which only the browser knows. Another sign-in
                  starts the screens afresh, so nothing of the last person's stays on them. */}
              <UnlessHidden me={boot.me}>
                <SyncChip me={boot.me} />
                <ShownOnce>
                  <Suspense fallback={<p role="status">Opening your jobs…</p>}>
                    <FieldApp key={meKey(boot.me.tenantId, boot.me.uid)} me={boot.me} />
                  </Suspense>
                </ShownOnce>
              </UnlessHidden>
            </FieldStore>
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
        {boot.kind === 'reopen' ? (
          <>
            <h1 className="text-2xl font-semibold">{REOPEN_TITLE}</h1>
            <p className="text-base">{REOPEN_STORAGE_TEXT}</p>
          </>
        ) : null}
        {boot.kind === 'ready' ? null : homeScreen}
      </main>
    </div>
  );
}
