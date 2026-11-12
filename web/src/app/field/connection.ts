'use client';

import { useEffect, useState } from 'react';

// Whether the phone can reach the app, for the "No signal" banner.
//
// `navigator.onLine` and the `online`/`offline` events are not enough: on an iPhone they stay
// "online" on Wi-Fi with no way out, and they say nothing when the network is cut behind the
// browser (the offline tests cut it at a proxy). So the page also asks the app's own health route
// when it opens, when it becomes visible, when the browser reports a change and every 15 seconds
// while it is visible and reachable (every 5 seconds while it is not, so the banner clears soon
// after the signal returns). Any answer at all, whatever its status, means the app was reached.
// The route answers with no person's data, and the worker lets the request through untouched.
const PROBE_PATH = '/api/health';
const ONLINE_EVERY_MS = 15_000;
const OFFLINE_EVERY_MS = 5_000;
const PROBE_TIMEOUT_MS = 8_000;

async function reachable(): Promise<boolean> {
  if (navigator.onLine === false) return false;
  try {
    await fetch(PROBE_PATH, { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

export function useReachable(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = true;
    let newest = 0;
    const check = async () => {
      const mine = ++newest;
      clearTimeout(timer);
      if (document.visibilityState === 'visible') {
        const answer = await reachable();
        if (stopped || mine !== newest) return;
        latest = answer;
        setOnline(latest);
      }
      timer = setTimeout(check, latest ? ONLINE_EVERY_MS : OFFLINE_EVERY_MS);
    };
    const wake = () => void check();
    window.addEventListener('online', wake);
    window.addEventListener('offline', wake);
    document.addEventListener('visibilitychange', wake);
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);
  return online;
}
