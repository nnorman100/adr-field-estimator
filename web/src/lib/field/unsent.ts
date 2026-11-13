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
// It also holds when the server first refused this person, and which refusal it was: the work
// stays locked through a start with no answer, and a disabled member's or inactive company's is
// removed after 30 days (owner decision O5). A mark that cannot be read counts as locked.
//
// localStorage, not IndexedDB, on purpose: it answers at once, and still answers when IndexedDB
// hangs, which is exactly when the start-up watchdog needs it. Keys are per (tenant, person), so
// one company's or one person's mark never speaks for another. The values are counts and times;
// no email, no field values.

import type { GateState } from './sync-gate';

export type LockReason = Extract<GateState, { kind: 'locked' }>['reason'];

const LOCK_REASONS: Record<LockReason, true> = {
  'verify-email': true,
  'needs-invitation': true,
  'member-disabled': true,
  'company-inactive': true,
  'second-step': true,
  'sign-in-again': true,
  'not-this-company': true,
  'account-disabled': true,
};

export type UnsentMark = {
  // Bumped by every write, so a clearing that started before a later write cannot clear it.
  writes: number;
  // When the oldest write not yet known to be acknowledged was made; null when there is none.
  unsentSince: number | null;
  // When the server first refused this person since they last got through; null when it has not.
  lockedSince: number | null;
  // Which refusal it was, while lockedSince is set.
  lockedReason?: LockReason;
  // Every unsent write was made in a memory cache (Online only, an iPhone browser tab, the
  // fallback): nothing of it is kept once that window closes.
  memoryOnly?: true;
};

const EMPTY: UnsentMark = { writes: 0, unsentSince: null, lockedSince: null };

export const unsentKey = (tenantId: string, uid: string): string => `ds-sync/${tenantId}/${uid}`;

function parse(raw: string | null): UnsentMark | null {
  if (raw === null) return { ...EMPTY };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const time = (field: unknown) => (typeof field === 'number' && Number.isFinite(field) ? field : null);
    if (typeof value.writes !== 'number' || !Number.isSafeInteger(value.writes)) return null;
    const lockedSince = time(value.lockedSince);
    const unsentSince = time(value.unsentSince);
    const mark: UnsentMark = { writes: value.writes, unsentSince, lockedSince };
    if (unsentSince !== null && value.memoryOnly === true) mark.memoryOnly = true;
    if (lockedSince !== null) {
      const reason = value.lockedReason;
      mark.lockedReason = typeof reason === 'string' && Object.hasOwn(LOCK_REASONS, reason) ? (reason as LockReason) : 'sign-in-again';
    }
    return mark;
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
  return unsentWork(tenantId, uid) !== 'none';
}

// Where the person's unsent work is: 'kept' on this phone (or a mark that cannot be read), only in
// the memory of a window ('memory'), or 'none'.
export function unsentWork(tenantId: string, uid: string): 'none' | 'kept' | 'memory' {
  const mark = readUnsent(tenantId, uid);
  if (mark === 'unreadable') return 'kept';
  if (mark.unsentSince === null) return 'none';
  return mark.memoryOnly ? 'memory' : 'kept';
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
// mark could not be saved (the write must then not be made: nothing would say it is unsent).
export function noteWrite(tenantId: string, uid: string, now = Date.now(), inMemory = false): number | null {
  let writes: number | null = null;
  const saved = change(tenantId, uid, ({ memoryOnly, ...mark }) => {
    writes = mark.writes + 1;
    const stillMemoryOnly = inMemory && (mark.unsentSince === null || memoryOnly === true);
    return { ...mark, writes, unsentSince: mark.unsentSince ?? now, ...(stillMemoryOnly ? { memoryOnly: true as const } : {}) };
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
  change(tenantId, uid, ({ memoryOnly, ...mark }) =>
    mark.writes === writes ? { ...mark, unsentSince: null } : { ...mark, ...(memoryOnly ? { memoryOnly } : {}) },
  );
}

// The server refused this person (O5). Returns when the refusals began, or null when the lock could
// not be saved.
export function noteLocked(tenantId: string, uid: string, reason: LockReason, now = Date.now()): number | null {
  let since = now;
  const saved = change(tenantId, uid, (mark) => {
    since = mark.lockedSince ?? now;
    return { ...mark, lockedSince: since, lockedReason: reason };
  });
  return saved ? since : null;
}

// The refusal this person's work is locked under on this phone, or null when it is not locked.
export function savedLock(tenantId: string, uid: string): LockReason | null {
  const mark = readUnsent(tenantId, uid);
  if (mark === 'unreadable') return 'sign-in-again';
  return mark.lockedSince === null ? null : (mark.lockedReason ?? 'sign-in-again');
}

export function noteUnlocked(tenantId: string, uid: string): void {
  const mark = readUnsent(tenantId, uid);
  if (mark !== 'unreadable' && mark.lockedSince === null) return;
  change(tenantId, uid, ({ lockedReason: _reason, ...current }) => {
    void _reason;
    return { ...current, lockedSince: null };
  });
}

// The person's work on this phone is gone (Discard, or the O5 limit): the mark goes with it.
export function forgetUnsent(tenantId: string, uid: string): void {
  try {
    window.localStorage.removeItem(unsentKey(tenantId, uid));
  } catch {
    // Nothing to forget, or nothing that can be: a later read says unreadable and asks again.
  }
}
