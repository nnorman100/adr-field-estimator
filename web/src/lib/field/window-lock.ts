// "Open DryScope in one window" (owner decision O3, S6-3). The Firestore cache uses its single-window
// manager, which says nothing when a second window opens it: the S6-1 tests found that each window
// then queues its own writes and one window's are lost (docs/plans/S6.md section 12, (d)). So the
// field shell takes this lock before it makes a Firestore client, and a window that cannot take it
// makes none. The lock is per origin, as the storage is: a Safari tab and the Home Screen app keep
// separate storage and never see each other, which is fine, as they never share a cache either.
//
// Web Locks are in Safari 15.4 and later, under the iOS 16.4 floor. A browser without them, or one
// that refuses the request, gets no field client at all: it cannot keep work offline.
// whileNoFieldWindow still runs there, because no field window can be open without the lock.

export const WINDOW_LOCK = 'ds-field-window';

type Locks = {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>): Promise<void>;
};

function locks(): Locks | null {
  const found = (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
  return found ?? null;
}

type Held = { result: 'held'; release: () => void } | { result: 'elsewhere' | 'unavailable' };

function request(): Promise<Held> {
  const available = locks();
  if (!available) return Promise.resolve({ result: 'unavailable' });
  return new Promise((resolve) => {
    let release = () => undefined as void;
    const held = new Promise<void>((done) => (release = done));
    available
      .request(WINDOW_LOCK, { ifAvailable: true }, async (lock) => {
        if (lock === null) {
          resolve({ result: 'elsewhere' });
          return;
        }
        resolve({ result: 'held', release });
        await held;
      })
      .catch(() => resolve({ result: 'unavailable' }));
  });
}

// This page's field window holds the lock.
let heldHere = false;
// This page's own short holds (whileNoFieldWindow), one after another. A field window starting on
// this page waits for them, so it never mistakes its own page's clean-up for another window.
let passing: Promise<unknown> = Promise.resolve();

// True while this page's field window holds the lock: no other window holds any field work, and
// work removed from this page needs no second lock (retention.ts).
export const holdsWindow = (): boolean => heldHere;

// Holds the lock for as long as this page lives (or until `release` is called). 'elsewhere' when
// another window of the same storage holds it.
export async function holdWindow(): Promise<Held> {
  await passing;
  const lock = await request();
  if (lock.result !== 'held') return lock;
  heldHere = true;
  return {
    result: 'held',
    release: () => {
      heldHere = false;
      lock.release();
    },
  };
}

// Runs `work` while holding the lock, or answers 'elsewhere' without running it when a field window
// is open (a sign-out that empties the cache must not pull it from under that window).
export function whileNoFieldWindow<T>(work: () => Promise<T>): Promise<T | 'elsewhere'> {
  const run = passing.then(async () => {
    const lock = await request();
    if (lock.result === 'elsewhere') return 'elsewhere' as const;
    try {
      return await work();
    } finally {
      if (lock.result === 'held') lock.release();
    }
  });
  passing = run.catch(() => undefined);
  return run;
}
