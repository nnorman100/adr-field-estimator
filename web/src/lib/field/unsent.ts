// Whether a person may have field edits on this phone that the server does not have yet (S6-3).
//
// The Firestore cache keeps queued writes, but it cannot be asked about them when it does not
// start (a stalled IndexedDB), and the sign-in pages that ask "keep or discard unsent work?" never
// start it. So every field write first records a mark here, and the mark is cleared only once the
// person's client has had every queued write acknowledged with the network on. A mark can be left
// behind (the app closed between the server's answer and the clearing); that only means one extra
// question or one "Reopen the app", never a lost edit. The recovery journal (S6-4) gives each edit
// its own entry later; until then this mark is what "unsent work" means.
//
// It also holds when the server first refused this person (member disabled, company inactive), for
// the 30-day limit after which locked work is removed (owner decision O5).
//
// localStorage, not IndexedDB, on purpose: it answers at once, and still answers when IndexedDB
// hangs, which is exactly when the start-up watchdog needs it. Keys are per (tenant, person), so
// one company's or one person's mark never speaks for another. The values are counts and times;
// no email, no field values.

export type UnsentMark = {
  // Bumped by every write, so a clearing that started before a later write cannot clear it.
  writes: number;
  // When the oldest write not yet known to be acknowledged was made; null when there is none.
  unsentSince: number | null;
  // When the server first refused this person since they last got through; null when it has not.
  lockedSince: number | null;
};

const EMPTY: UnsentMark = { writes: 0, unsentSince: null, lockedSince: null };

export const unsentKey = (tenantId: string, uid: string): string => `ds-sync/${tenantId}/${uid}`;

function parse(raw: string | null): UnsentMark | null {
  if (raw === null) return { ...EMPTY };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const time = (field: unknown) => (typeof field === 'number' && Number.isFinite(field) ? field : null);
    if (typeof value.writes !== 'number' || !Number.isSafeInteger(value.writes)) return null;
    return { writes: value.writes, unsentSince: time(value.unsentSince), lockedSince: time(value.lockedSince) };
  } catch {
    return null;
  }
}

// The mark, or 'unreadable' when the phone's storage cannot be read (or holds something this code
// did not write): the callers then act as if work were waiting.
export function readUnsent(tenantId: string, uid: string): UnsentMark | 'unreadable' {
  try {
    return parse(window.localStorage.getItem(unsentKey(tenantId, uid))) ?? 'unreadable';
  } catch {
    return 'unreadable';
  }
}

// True when the person may have unsent work: a write not yet known to be acknowledged, or a mark
// that cannot be read.
export function mayHaveUnsent(tenantId: string, uid: string): boolean {
  const mark = readUnsent(tenantId, uid);
  return mark === 'unreadable' || mark.unsentSince !== null;
}

function change(tenantId: string, uid: string, update: (mark: UnsentMark) => UnsentMark): boolean {
  try {
    const now = readUnsent(tenantId, uid);
    const next = update(now === 'unreadable' ? { ...EMPTY, unsentSince: Date.now() } : now);
    window.localStorage.setItem(unsentKey(tenantId, uid), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

// Records a write about to be made. Returns the write count to pass to settled(), or null when the
// mark could not be saved (the write still goes ahead: the edit itself is safe in the cache).
export function noteWrite(tenantId: string, uid: string, now = Date.now()): number | null {
  let writes: number | null = null;
  const saved = change(tenantId, uid, (mark) => {
    writes = mark.writes + 1;
    return { ...mark, writes, unsentSince: mark.unsentSince ?? now };
  });
  return saved ? writes : null;
}

// The write count now, for a clearing that starts now.
export function writesNow(tenantId: string, uid: string): number | null {
  const mark = readUnsent(tenantId, uid);
  return mark === 'unreadable' ? null : mark.writes;
}

// Every write made up to `writes` has been acknowledged: clears the mark, unless a later write has
// been made since (it may still be waiting).
export function settled(tenantId: string, uid: string, writes: number): void {
  change(tenantId, uid, (mark) => (mark.writes === writes ? { ...mark, unsentSince: null } : mark));
}

// The server refused this person (O5). Returns when the refusals began.
export function noteLocked(tenantId: string, uid: string, now = Date.now()): number {
  let since = now;
  change(tenantId, uid, (mark) => {
    since = mark.lockedSince ?? now;
    return { ...mark, lockedSince: since };
  });
  return since;
}

export function noteUnlocked(tenantId: string, uid: string): void {
  const mark = readUnsent(tenantId, uid);
  if (mark !== 'unreadable' && mark.lockedSince === null) return;
  change(tenantId, uid, (current) => ({ ...current, lockedSince: null }));
}

// The person's work on this phone is gone (Discard, or the O5 limit): the mark goes with it.
export function forgetUnsent(tenantId: string, uid: string): void {
  try {
    window.localStorage.removeItem(unsentKey(tenantId, uid));
  } catch {
    // Nothing to forget, or nothing that can be: a later read says unreadable and asks again.
  }
}
