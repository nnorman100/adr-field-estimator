import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import type { FieldPerson } from '@/lib/field-db';
import type { DsMe } from '@/lib/field/ds-me';
import type { LockReason, SavedReason } from '@/lib/field/unsent';

// S6-3b: the phone's one retention routine, evaluate(now, event) in src/lib/field/retention.ts.
// The examples are the paths the reviews found; the property runs random sequences of refusals,
// sign-outs, sign-ins, days passing, the phone opening in two tabs, storage that refuses and another
// window holding the work, and checks the owner's two rules (decision 010) after every step:
//   - work of someone locked out for more than 30 days is hidden (never shown or opened offline)
//     at every entry point, read from the lock and the clock alone;
//   - work is removed only when the server refuses the person at that moment, never on what the
//     phone alone holds.
//
// The phone here is real localStorage-shaped storage with the app's own marks in it, a list of
// saved sign-ins standing in for ds-me, and a set of people whose field database holds work.

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 14, 8, 0, 0);
const config: BrowserSignInConfig = { apiKey: 'key', authDomain: 'example.test', projectId: 'demo-field', authEmulatorUrl: null, firestoreDatabaseId: 'field' };
const keyOf = (person: { tenantId: string; uid: string }) => `${person.tenantId}/${person.uid}`;

const phone = {
  items: new Map<string, string>(),
  rows: new Map<string, DsMe>(),
  work: new Set<string>(),
  // setItem throws (a full phone); removeItem and reads still answer.
  quota: false,
  // The field database cannot be cleared.
  discardFails: false,
  // A field window is open in another tab, which holds everyone's work.
  otherWindow: false,
  // This page is the field window and holds the one-window lock.
  ownsWindow: false,
  // ds-me cannot be read.
  rowsUnreadable: false,
  discards: [] as { person: string; lockHeld: boolean }[],
  // What happened, in order: 'removed <person>', 'forgot <person>' (the saved sign-in).
  log: [] as string[],
  reset() {
    this.items.clear();
    this.rows.clear();
    this.work.clear();
    this.discards.length = 0;
    this.log.length = 0;
    this.quota = this.discardFails = this.otherWindow = this.ownsWindow = this.rowsUnreadable = false;
  },
};

const storage = {
  getItem: (key: string) => phone.items.get(key) ?? null,
  setItem(key: string, value: string) {
    if (phone.quota) throw new DOMException('full', 'QuotaExceededError');
    phone.items.set(key, value);
  },
  removeItem: (key: string) => void phone.items.delete(key),
  get length() {
    return phone.items.size;
  },
  key: (index: number) => [...phone.items.keys()][index] ?? null,
};

vi.mock('@/lib/field/ds-me', async (original) => ({
  ...(await original<typeof import('@/lib/field/ds-me')>()),
  readAllMe: async () => (phone.rowsUnreadable ? [] : [...phone.rows.values()]),
  readMe: async (tenantId: string, uid: string) => phone.rows.get(keyOf({ tenantId, uid })) ?? null,
  // As src/lib/field/ds-me.ts: only the row the sign-out found goes.
  forgetMe: async (tenantId: string, uid: string, savedAt: number | null) => {
    const row = phone.rows.get(keyOf({ tenantId, uid })) ?? null;
    if ((row?.savedAt ?? null) !== savedAt) return false;
    phone.rows.delete(keyOf({ tenantId, uid }));
    phone.log.push(`forgot ${keyOf({ tenantId, uid })}`);
    return row;
  },
  saveMe: async () => true,
  restoreMe: async () => true,
}));
vi.mock('@/lib/firebase-client', () => ({ signOutCompany: async () => undefined }));
vi.mock('@/lib/field/window-lock', () => ({ holdsWindow: () => phone.ownsWindow }));
vi.mock('@/lib/field-db', async () => {
  const { forgetUnsent } = await import('@/lib/field/unsent');
  return {
    stopFieldClient: async () => undefined,
    // As src/lib/field-db.ts: nothing goes while another window holds the work or the database
    // cannot be cleared; otherwise the database and the person's mark go together.
    discardFieldWork: async (person: FieldPerson, { lockHeld = false } = {}) => {
      phone.discards.push({ person: keyOf(person), lockHeld });
      // Clearing a database takes a while: anything not waiting for it runs first.
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      if (phone.otherWindow && !lockHeld) return 'elsewhere';
      if (phone.discardFails) return 'failed';
      phone.log.push(`removed ${keyOf(person)}`);
      phone.work.delete(keyOf(person));
      forgetUnsent(person.tenantId, person.uid);
      return 'discarded';
    },
  };
});

const { cleanupKey, evaluate, onWorkRemoved, takeRemoved, watchRetention, WATCH_EVERY_MS } = await import('@/lib/field/retention');
const { signOutKeeping, signOutOnRefusal, WorkNotSecuredError } = await import('@/lib/field/sign-out');
// A second tab: its own copy of the routine's module, over the same storage and saved sign-ins.
vi.resetModules();
const secondTab = { ...(await import('@/lib/field/retention')), ...(await import('@/lib/field/sign-out')) };
const firstTab = { evaluate, onWorkRemoved, signOutKeeping, signOutOnRefusal, WorkNotSecuredError };
const TABS = [firstTab, secondTab];
const { sessionValid } = await import('@/lib/field/sync-gate');
const { RETAINED_REASONS, lockOutlived, noteWrite, readUnsent, unsentKey } = await import('@/lib/field/unsent');
// O5: 30 days, said here and not read from the code under test.
const LOCKED_LIMIT_MS = 30 * DAY;

const person = (tenantId: string, uid: string): FieldPerson => ({ tenantId, uid, config });
const ana = person('t-a', 'ana');
const ben = person('t-a', 'ben');
const otherAna = person('t-b', 'ana');

function saveRow(who: FieldPerson, role: string, authTime: number): void {
  phone.rows.set(keyOf(who), { ...who, companyName: 'Company', address: 'company', savedAt: authTime, role, authTime });
}
function giveWork(who: FieldPerson, now: number): void {
  noteWrite(who.tenantId, who.uid, now);
  phone.work.add(keyOf(who));
}
const lockOf = (who: FieldPerson) => {
  const mark = readUnsent(who.tenantId, who.uid);
  if (mark === 'unreadable' || mark.lockedSince === null) return null;
  return { since: mark.lockedSince, reason: mark.lockedReason };
};
const authFor = (who: FieldPerson) => ({ currentUser: { uid: who.uid, metadata: { lastSignInTime: 'Fri, 13 Nov 2026 09:00:00 GMT' } } }) as unknown as Auth;

let clock = START;
const setClock = (now: number) => {
  clock = now;
  vi.setSystemTime(now);
};

beforeEach(() => {
  phone.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  setClock(START);
  vi.stubGlobal('window', { localStorage: storage });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the states of one person', () => {
  it('a refusal locks from the first one, and the server letting them in lifts it', async () => {
    giveWork(ana, START);
    expect(evaluate(START, { kind: 'entry', person: ana }).state).toBe('none');
    expect(evaluate(START + DAY, { kind: 'refused', person: ana, reason: 'member-disabled' }).state).toBe('locked');
    expect(evaluate(START + 2 * DAY, { kind: 'refused', person: ana, reason: 'sign-in-again' }).state).toBe('locked');
    // The first refusal's time, and the more specific reason, are kept.
    expect(lockOf(ana)).toEqual({ since: START + DAY, reason: 'member-disabled' });
    // Locked for exactly 30 days: still kept.
    const day30 = evaluate(START + 31 * DAY, { kind: 'entry', person: ana });
    expect(day30.state).toBe('locked');
    expect(await day30.done).toEqual([]);

    const back = evaluate(START + 31 * DAY, { kind: 'let-in', person: ana });
    expect(back.state).toBe('none');
    expect(await back.done).toEqual([]);
    expect(lockOf(ana)).toBeNull();
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });

  it('locked for more than 30 days is hidden: only a refusal the server gives just now removes the work', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'session-revoked' });
    const later = START + LOCKED_LIMIT_MS + 1;

    // Opening, a refusal the phone makes itself, any number of times, in either tab: hidden, kept.
    for (const tab of TABS) {
      const opened = tab.evaluate(later, { kind: 'entry', person: ana });
      expect(opened.state).toBe('hidden');
      expect(await opened.done).toEqual([]);
      const madeUp = tab.evaluate(later, { kind: 'refused', person: ana, reason: 'account-disabled' });
      expect(madeUp.state).toBe('hidden');
      expect(await madeUp.done).toEqual([]);
    }
    expect(lockOf(ana)).toEqual({ since: START, reason: 'session-revoked' });
    expect(phone.work.has(keyOf(ana))).toBe(true);

    // The server refuses her while another window holds the work: it cannot go yet.
    phone.otherWindow = true;
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'session-revoked', fromServer: true }).done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
    phone.otherWindow = false;
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'session-revoked', fromServer: true }).done).toEqual(['t-a/ana']);
    expect(phone.work.has(keyOf(ana))).toBe(false);
    expect(evaluate(later, { kind: 'entry', person: ana }).state).toBe('none');
    // Her shell, started after it went, is still told, once.
    expect(takeRemoved('t-a/ana')).toBe(true);
    expect(takeRemoved('t-a/ana')).toBe(false);
  });

  it('a let-in shows hidden work again: the person\'s own lock goes, however old, and nothing is removed', async () => {
    giveWork(ana, START);
    giveWork(ben, START);
    for (const who of [ana, ben]) evaluate(START, { kind: 'refused', person: who, reason: 'sign-in-again' });
    const later = START + 40 * DAY;
    const back = secondTab.evaluate(later, { kind: 'let-in', person: ana });
    expect(back.state).toBe('none');
    expect(await back.done).toEqual([]);
    expect(lockOf(ana)).toBeNull();
    expect(phone.work.has(keyOf(ana))).toBe(true);
    // Anyone else's stays as it was.
    expect(evaluate(later, { kind: 'entry', person: ben }).state).toBe('hidden');
    expect(phone.work.has(keyOf(ben))).toBe(true);
  });

  it('a refusal that is not removed after 30 days never hides the work', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'second-step' });
    const much = evaluate(START + 400 * DAY, { kind: 'entry', person: ana });
    expect(much.state).toBe('locked');
    expect(await much.done).toEqual([]);
    expect(await evaluate(START + 400 * DAY, { kind: 'refused', person: ana, reason: 'second-step', fromServer: true }).done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });

  it('says "unsaved", and changes nothing, when the phone cannot save a refusal', async () => {
    giveWork(ana, START);
    const before = phone.items.get(unsentKey('t-a', 'ana'));
    phone.quota = true;
    expect(evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' }).state).toBe('unsaved');
    expect(phone.items.get(unsentKey('t-a', 'ana'))).toBe(before);
    expect(phone.items.has(cleanupKey('t-a'))).toBe(false);
    // A lock saved earlier still stands on a phone that is full now, but this refusal is not
    // saved: it is never reported as if it were.
    phone.quota = false;
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    phone.quota = true;
    expect(evaluate(START + DAY, { kind: 'refused', person: ana, reason: 'sign-in-again' }).state).toBe('unsaved');
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-again' });
  });

  it('keeps the saved sign-in when a refusal cannot be saved over an earlier lock of another kind', async () => {
    saveRow(ana, 'estimator', START);
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'second-step' });
    phone.quota = true;
    await expect(signOutOnRefusal(authFor(ana), 't-a', config, 'sign-in-again', true)).rejects.toBeInstanceOf(WorkNotSecuredError);
    expect(phone.rows.has(keyOf(ana))).toBe(true);
    expect(lockOf(ana)).toEqual({ since: START, reason: 'second-step' });

    // Room again: the refusal is saved and the 30 days run.
    phone.quota = false;
    await signOutOnRefusal(authFor(ana), 't-a', config, 'sign-in-again', true);
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-again' });
    expect(phone.rows.has(keyOf(ana))).toBe(false);
    const later = START + LOCKED_LIMIT_MS + 1;
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual([]);
    expect(evaluate(later, { kind: 'entry', person: ana }).state).toBe('hidden');
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'sign-in-again', fromServer: true }).done).toEqual(['t-a/ana']);
  });

  it('a refusal it could not save leaves the work as it was: not locked, so neither hidden nor removed later', async () => {
    giveWork(ana, START);
    phone.quota = true;
    expect(evaluate(START, { kind: 'refused', person: ana, reason: 'company-inactive', fromServer: true }).state).toBe('unsaved');
    phone.quota = false;
    expect(await evaluate(START + 31 * DAY, { kind: 'entry' }).done).toEqual([]);
    expect(evaluate(START + 31 * DAY, { kind: 'entry', person: ana }).state).toBe('none');
    // The server's next refusal is saved from then, and removes nothing yet.
    const again = evaluate(START + 31 * DAY, { kind: 'refused', person: ana, reason: 'company-inactive', fromServer: true });
    expect(again.state).toBe('locked');
    expect(await again.done).toEqual([]);
    expect(lockOf(ana)).toEqual({ since: START + 31 * DAY, reason: 'company-inactive' });
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });

  it('a Keep that could not lock an expired sign-in leaves nothing another tab could act on later', async () => {
    // An owner's sign-in counts for 14 days.
    saveRow(ana, 'owner', START - 15 * DAY);
    giveWork(ana, START - 20 * DAY);
    phone.quota = true;
    const failure = await signOutKeeping(authFor(ana), 't-a').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkNotSecuredError);
    phone.quota = false;

    // Day 29: the owner signs in again in another tab, and works there.
    setClock(START + 29 * DAY);
    saveRow(ana, 'owner', START + 29 * DAY);
    await secondTab.evaluate(START + 29 * DAY, { kind: 'let-in', person: ana }).done;
    noteWrite('t-a', 'ana', START + 29 * DAY);

    // Day 31: this tab is shown again. Her work stays, and nothing is locked.
    setClock(START + 31 * DAY);
    expect(await evaluate(START + 31 * DAY, { kind: 'entry' }).done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
    expect(lockOf(ana)).toBeNull();
    expect(evaluate(START + 31 * DAY, { kind: 'entry', person: ana }).state).toBe('none');
  });

  it('a Keep that could not lock an expired sign-in locks it when "Try again" succeeds', async () => {
    saveRow(ana, 'estimator', START - 31 * DAY);
    giveWork(ana, START - 2 * DAY);
    phone.quota = true;
    const failure = await signOutKeeping(authFor(ana), 't-a').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkNotSecuredError);
    phone.quota = false;
    setClock(START + DAY);
    await (failure as InstanceType<typeof WorkNotSecuredError>).retry();
    expect(lockOf(ana)).toEqual({ since: START + DAY, reason: 'sign-in-expired' });
    expect(phone.rows.has(keyOf(ana))).toBe(false);
  });

  it('a let-in lifts only the person\'s own lock, in either tab, and one the phone cannot save lets nothing open', async () => {
    giveWork(ana, START);
    giveWork(ben, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    evaluate(START, { kind: 'refused', person: ben, reason: 'sign-in-again' });
    phone.quota = true;
    expect(evaluate(START, { kind: 'let-in', person: ana }).state).toBe('unsaved');
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-again' });
    phone.quota = false;
    expect(secondTab.evaluate(START + 60_000, { kind: 'let-in', person: ana }).state).toBe('none');
    await evaluate(START + 120_000, { kind: 'entry' }).done;
    expect(lockOf(ana)).toBeNull();
    expect(lockOf(ben)).toEqual({ since: START, reason: 'sign-in-again' });
    expect(evaluate(START + 120_000, { kind: 'entry', person: ana }).state).toBe('none');
  });

  it('counts the 30 days from the first refusal, kept through later ones', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'session-revoked' });
    evaluate(START + 10 * DAY, { kind: 'refused', person: ana, reason: 'session-revoked', fromServer: true });
    expect(evaluate(START + 30 * DAY, { kind: 'entry', person: ana }).state).toBe('locked');
    expect(evaluate(START + 30 * DAY + 1, { kind: 'entry', person: ana }).state).toBe('hidden');
  });

  it('says "unsaved" for a let-in it cannot save, and never removes the work of someone the server let in', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    phone.quota = true;
    const day29 = START + 29 * DAY;
    expect(evaluate(day29, { kind: 'let-in', person: ana }).state).toBe('unsaved');
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-again' });

    // Storage answers again; the let-in is asked for again and saved before anything opens.
    phone.quota = false;
    expect(evaluate(day29, { kind: 'let-in', person: ana }).state).toBe('none');
    expect(lockOf(ana)).toBeNull();
    expect(await evaluate(START + 31 * DAY, { kind: 'entry' }).done).toEqual([]);
    expect(await evaluate(START + 31 * DAY, { kind: 'refused', person: ana, reason: 'sign-in-again', fromServer: true }).done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });
});

describe('the sweep after every event', () => {
  it('starts the clock for a saved sign-in past its role\'s limit that no server refused, and for nobody else', async () => {
    // An estimator signed in 31 days ago, an owner 15 days ago, an estimator yesterday.
    saveRow(ana, 'estimator', START - 31 * DAY);
    saveRow(ben, 'owner', START - 15 * DAY);
    saveRow(otherAna, 'estimator', START - DAY);
    for (const who of [ana, ben, otherAna]) giveWork(who, START - 2 * DAY);

    expect(await evaluate(START, { kind: 'entry' }).done).toEqual([]);
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-expired' });
    expect(lockOf(ben)).toEqual({ since: START, reason: 'sign-in-expired' });
    expect(lockOf(otherAna)).toBeNull();
    expect(phone.work.size).toBe(3);

    // Reopened again and again with no signal, the first time stays; 30 days on, the work is
    // hidden, and nothing is removed.
    await evaluate(START + 10 * DAY, { kind: 'entry' }).done;
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-expired' });
    const later = START + LOCKED_LIMIT_MS + 1;
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual([]);
    // The other Ana's sign-in has passed its own limit meanwhile: locked from now.
    expect([ana, ben, otherAna].map((who) => evaluate(later, { kind: 'entry', person: who }).state)).toEqual(['hidden', 'hidden', 'locked']);
    expect(phone.work.size).toBe(3);
  });

  it('lifts a lock that only the sign-in\'s age made once a newer saved sign-in counts, and no other lock', async () => {
    for (const who of [ana, ben, otherAna]) {
      saveRow(who, 'estimator', START - 31 * DAY);
      giveWork(who, START - 2 * DAY);
    }
    // Ben was also refused by the server; the other Ana's lock outlives the 30 days.
    evaluate(START, { kind: 'refused', person: ben, reason: 'sign-in-again' });
    await evaluate(START, { kind: 'entry' }).done;
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-expired' });
    expect(lockOf(ben)).toEqual({ since: START, reason: 'sign-in-again' });
    // A sign-in's age replaces no refusal, and a refusal replaces it.
    await evaluate(START + DAY, { kind: 'refused', person: otherAna, reason: 'sign-in-again' }).done;
    expect(lockOf(otherAna)).toEqual({ since: START, reason: 'sign-in-again' });
    phone.items.set(unsentKey('t-b', 'ana'), JSON.stringify({ writes: 1, unsentSince: START, lockedSince: START - 20 * DAY, lockedReason: 'sign-in-expired' }));

    // Each signs in again 20 days on; only the saved row says so (the page closed before the lock
    // was lifted). By then the other Ana has been locked out for 40 days: hidden, and kept.
    const later = START + 20 * DAY;
    for (const who of [ana, ben, otherAna]) saveRow(who, 'estimator', later - DAY);
    phone.otherWindow = true;
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual([]);
    expect(lockOf(ana)).toBeNull();
    expect(lockOf(ben)).toEqual({ since: START, reason: 'sign-in-again' });
    expect(lockOf(otherAna)).toEqual({ since: START - 20 * DAY, reason: 'sign-in-expired' });
    expect(phone.work.has(keyOf(ana))).toBe(true);
    expect(phone.work.has(keyOf(otherAna))).toBe(true);

    // The caller's own saved sign-in is judged at once, before the sweep.
    saveRow(ana, 'estimator', later - 31 * DAY);
    expect(evaluate(later, { kind: 'entry', person: ana, saved: { role: 'estimator', authTime: later - 31 * DAY } }).state).toBe('locked');
    expect(evaluate(later, { kind: 'entry', person: ana, saved: { role: 'estimator', authTime: later } }).state).toBe('none');
  });

  it('does not lock anyone out when the saved sign-ins cannot be read', async () => {
    saveRow(ana, 'estimator', START - 31 * DAY);
    phone.rowsUnreadable = true;
    await evaluate(START, { kind: 'entry' }).done;
    expect(lockOf(ana)).toBeNull();
  });

  it('removes only the work of the person the server refused, never anyone else\'s, whoever else is hidden', async () => {
    for (const who of [ana, ben, otherAna]) {
      giveWork(who, START);
      evaluate(START, { kind: 'refused', person: who, reason: 'sign-in-again' });
    }
    evaluate(START + 20 * DAY, { kind: 'let-in', person: ben });
    const removed: string[] = [];
    const stop = onWorkRemoved((who) => removed.push(who));

    const later = START + LOCKED_LIMIT_MS + 1;
    expect(await evaluate(later, { kind: 'refused', person: ben, reason: 'member-disabled', fromServer: true }).done).toEqual([]);
    expect(lockOf(ben)).toEqual({ since: later, reason: 'member-disabled' });
    expect(phone.work.size).toBe(3);
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'sign-in-again', fromServer: true }).done).toEqual(['t-a/ana']);
    expect(removed).toEqual(['t-a/ana']);
    expect([...phone.work].sort()).toEqual(['t-a/ben', 't-b/ana']);
    stop();
  });

  it('removes from the field window itself with the lock it holds, and from any other page only when no field window is open', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'company-inactive' });
    const later = START + LOCKED_LIMIT_MS + 1;
    const refused = () => evaluate(later, { kind: 'refused', person: ana, reason: 'company-inactive', fromServer: true }).done;

    phone.otherWindow = true;
    expect(await refused()).toEqual([]);
    expect(phone.discards.at(-1)).toEqual({ person: 't-a/ana', lockHeld: false });
    phone.otherWindow = false;
    phone.ownsWindow = true;
    expect(await refused()).toEqual(['t-a/ana']);
    expect(phone.discards.at(-1)).toEqual({ person: 't-a/ana', lockHeld: true });
  });

  it('a removal the phone\'s storage refused waits for the next refusal from the server, not for an entry point', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    const later = START + LOCKED_LIMIT_MS + 1;
    phone.discardFails = true;
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'sign-in-again', fromServer: true }).done).toEqual([]);
    const still = evaluate(later, { kind: 'entry', person: ana });
    expect(still.state).toBe('hidden');
    expect(await still.done).toEqual([]);
    phone.discardFails = false;
    expect(await evaluate(later + 1, { kind: 'entry' }).done).toEqual([]);
    expect(await evaluate(later + 1, { kind: 'refused', person: ana, reason: 'sign-in-again', fromServer: true }).done).toEqual(['t-a/ana']);
  });

  it('runs one removal at a time: two refusals at once remove a person once', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    const later = START + LOCKED_LIMIT_MS + 1;
    const refused = () => evaluate(later, { kind: 'refused', person: ana, reason: 'sign-in-again', fromServer: true }).done;
    const [first, second] = await Promise.all([refused(), refused()]);
    expect([first, second]).toEqual([['t-a/ana'], []]);
    expect(phone.discards).toHaveLength(1);
  });

  it('removes nothing on a guess: not on opening, and not for a mark it cannot read', async () => {
    const later = START + LOCKED_LIMIT_MS + 1;
    phone.items.set(unsentKey('t-a', 'ana'), '{not json');
    // A lock an earlier version saved without the company's settings, and no saved sign-in.
    phone.items.set(unsentKey('t-a', 'ben'), JSON.stringify({ writes: 1, unsentSince: START, lockedSince: START, lockedReason: 'sign-in-again' }));
    phone.work.add(keyOf(ben));
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual([]);
    expect(await evaluate(later, { kind: 'entry', company: { tenantId: 't-a', config } }).done).toEqual([]);
    const unread = evaluate(later, { kind: 'entry', person: ana });
    expect(unread.state).toBe('locked');
    expect(await unread.done).toEqual([]);
    expect(phone.discards).toEqual([]);
    expect(phone.items.get(unsentKey('t-a', 'ana'))).toBe('{not json');

    // The server's refusal brings the person's own settings, which name the database.
    expect(await evaluate(later, { kind: 'refused', person: ben, reason: 'sign-in-again', fromServer: true }).done).toEqual(['t-a/ben']);
    expect(phone.discards).toEqual([{ person: 't-a/ben', lockHeld: false }]);
  });

  it('keeps the settings a company\'s own page brings, and removes nothing for it', async () => {
    const later = START + LOCKED_LIMIT_MS + 1;
    phone.items.set(unsentKey('t-a', 'ben'), JSON.stringify({ writes: 1, unsentSince: START, lockedSince: START, lockedReason: 'sign-in-again' }));
    phone.work.add(keyOf(ben));
    expect(await evaluate(later, { kind: 'entry', company: { tenantId: 't-b', config } }).done).toEqual([]);
    expect(phone.items.has(cleanupKey('t-b'))).toBe(true);
    expect(await evaluate(later, { kind: 'entry', company: { tenantId: 't-a', config } }).done).toEqual([]);
    expect(phone.work.has(keyOf(ben))).toBe(true);
  });
});

describe('a sign-out the app makes on a refusal', () => {
  it('removes work already past the limit before the saved sign-in goes, when the server refused', async () => {
    saveRow(ana, 'estimator', START);
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    setClock(START + LOCKED_LIMIT_MS + 1);
    await signOutOnRefusal(authFor(ana), 't-a', config, 'sign-in-again', true);
    expect(phone.log).toEqual(['removed t-a/ana', 'forgot t-a/ana']);
    expect(phone.work.has(keyOf(ana))).toBe(false);
    expect(phone.rows.has(keyOf(ana))).toBe(false);
  });

  it('removes nothing on a refusal the phone made itself, and the sign-in still goes', async () => {
    saveRow(ana, 'estimator', START);
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    setClock(START + LOCKED_LIMIT_MS + 1);
    await signOutOnRefusal(authFor(ana), 't-a', config, 'not-this-company');
    expect(phone.log).toEqual(['forgot t-a/ana']);
    expect(phone.work.has(keyOf(ana))).toBe(true);
    expect(evaluate(Date.now(), { kind: 'entry', person: ana }).state).toBe('hidden');
  });
});

describe('the person\'s own sign-out', () => {
  // An owner's sign-in counts for 14 days.
  const OWNER_LIMIT = 14 * DAY;

  it('locks a sign-in that passed its 14 days before Keep removes it, so the 30 days run with no row left', async () => {
    saveRow(ana, 'owner', START - OWNER_LIMIT + 60_000);
    giveWork(ana, START);
    const keep = START + 2 * 60_000;
    setClock(keep);
    await signOutKeeping(authFor(ana), 't-a');
    expect(phone.rows.has(keyOf(ana))).toBe(false);
    expect(lockOf(ana)).toEqual({ since: keep, reason: 'sign-in-expired' });
    expect(evaluate(keep + LOCKED_LIMIT_MS, { kind: 'entry', person: ana }).state).toBe('locked');
    expect(await evaluate(keep + LOCKED_LIMIT_MS + 1, { kind: 'entry' }).done).toEqual([]);
    expect(evaluate(keep + LOCKED_LIMIT_MS + 1, { kind: 'entry', person: ana }).state).toBe('hidden');
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });

  it('keeps the saved sign-in when that lock cannot be saved, and "Try again" finishes the sign-out', async () => {
    saveRow(ana, 'owner', START - OWNER_LIMIT - 1);
    giveWork(ana, START);
    phone.quota = true;
    const failure = await signOutKeeping(authFor(ana), 't-a').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkNotSecuredError);
    expect(phone.rows.has(keyOf(ana))).toBe(true);
    expect(lockOf(ana)).toBeNull();

    phone.quota = false;
    await (failure as InstanceType<typeof WorkNotSecuredError>).retry();
    expect(phone.rows.has(keyOf(ana))).toBe(false);
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-expired' });
  });

  it('with a sign-in that still counts, Keep locks nothing, on a full phone too', async () => {
    saveRow(ana, 'owner', START - OWNER_LIMIT + 60_000);
    giveWork(ana, START);
    phone.quota = true;
    await signOutKeeping(authFor(ana), 't-a');
    expect(phone.rows.has(keyOf(ana))).toBe(false);
    expect(lockOf(ana)).toBeNull();
  });
});

describe('the entry points every page shares', () => {
  // A page's document and window, as far as the watcher uses them.
  function page() {
    const heard = new Map<string, Set<() => void>>();
    const target = {
      addEventListener: (type: string, listener: () => void) => void (heard.get(type) ?? heard.set(type, new Set()).get(type)!).add(listener),
      removeEventListener: (type: string, listener: () => void) => void heard.get(type)?.delete(listener),
    };
    const document = { ...target, visibilityState: 'visible' };
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', { ...target, localStorage: storage });
    return { document, fire: (type: string) => heard.get(type)?.forEach((listener) => listener()) };
  }
  const settle = async () => {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
  };
  // Ana's estimator sign-in is 29 days old as the page opens, and Ben's work was locked on day 0.
  function day29() {
    saveRow(ana, 'estimator', START - 29 * DAY);
    giveWork(ana, START - 29 * DAY);
    giveWork(ben, START - 29 * DAY);
    evaluate(START - 29 * DAY, { kind: 'refused', person: ben, reason: 'sign-in-again' });
  }

  it.each([
    ['made visible again', (shown: ReturnType<typeof page>) => shown.fire('visibilitychange')],
    ['brought back from the back-forward cache', (shown: ReturnType<typeof page>) => shown.fire('pageshow')],
    ['left open and shown, at the next minute', () => vi.advanceTimersByTime(WATCH_EVERY_MS)],
  ])('run the routine as the page opens and when it is %s, removing nothing', async (_name, again) => {
    vi.useFakeTimers();
    setClock(START);
    const shown = page();
    day29();
    const stop = watchRetention();
    await settle();
    expect(lockOf(ana)).toBeNull();

    // Two days pass with the page hidden: nothing runs while it is.
    setClock(START + 2 * DAY);
    shown.document.visibilityState = 'hidden';
    again(shown);
    await settle();
    expect(lockOf(ana)).toBeNull();

    // Shown again: Ana's sign-in is past its 30 days, so her clock starts; Ben's work is hidden.
    shown.document.visibilityState = 'visible';
    again(shown);
    await settle();
    expect(lockOf(ana)).toMatchObject({ reason: 'sign-in-expired' });
    expect(lockOf(ana)!.since).toBeGreaterThanOrEqual(START + 2 * DAY);
    expect(lockOutlived('t-a', 'ben', Date.now())).toBe(true);
    expect([...phone.work].sort()).toEqual(['t-a/ana', 't-a/ben']);
    stop();
  });

  it('hide, and remove nothing of, work that outlived the limit while the page was closed, as it opens', async () => {
    page();
    day29();
    setClock(START + 2 * DAY);
    const stop = watchRetention();
    await settle();
    expect(phone.work.has(keyOf(ben))).toBe(true);
    expect(evaluate(Date.now(), { kind: 'entry', person: ben }).state).toBe('hidden');
    expect(phone.discards).toEqual([]);
    stop();
  });

  it('keep the settings of the company whose page it is, and stop when told to', async () => {
    vi.useFakeTimers();
    setClock(START);
    const shown = page();
    day29();
    const stop = watchRetention({ tenantId: 't-b', config });
    await settle();
    expect(phone.items.has(cleanupKey('t-b'))).toBe(true);
    stop();
    setClock(START + 2 * DAY);
    shown.fire('visibilitychange');
    shown.fire('pageshow');
    vi.advanceTimersByTime(10 * WATCH_EVERY_MS);
    await settle();
    expect(lockOf(ana)).toBeNull();
  });
});

// The model: what the owner's rules say each person's lock, saved sign-in and work must be, written
// from the rules (docs/plans/S6.md, O5 and decision 010) and not from the code under test. Two tabs
// share the phone's storage and saved sign-ins.
// `admitted`: the server let them in, and the lock was lifted, since they were last locked out.
type Model = { lock: { since: number; reason: SavedReason } | null; row: { role: string; authTime: number } | null; work: boolean; admitted: boolean };
const PEOPLE = [ana, ben, otherAna];
const REASONS: LockReason[] = [
  'verify-email',
  'needs-invitation',
  'member-disabled',
  'company-inactive',
  'second-step',
  'sign-in-again',
  'not-this-company',
  'account-disabled',
  'session-revoked',
];

type Tab = 0 | 1;
type Command =
  | { kind: 'hours'; hours: number }
  | { kind: 'entry'; tab: Tab }
  // A suspended tab shown again (visibilitychange, pageshow): the routine runs for the page's company.
  | { kind: 'resume'; tab: Tab }
  | { kind: 'write'; who: number }
  // The sync gate: the server's refusal (GET /api/me), the gate's own "no sign-in to ask with", a
  // saved sign-in found past its role's limit, any other check, and the server letting them in.
  | { kind: 'gate-refused'; who: number; tab: Tab; reason: LockReason }
  | { kind: 'gate-signed-out'; who: number; tab: Tab }
  | { kind: 'gate-expired'; who: number; tab: Tab }
  | { kind: 'gate-check'; who: number; tab: Tab }
  | { kind: 'gate-open'; who: number; tab: Tab }
  // A screen ends the sign-in: on the server's refusal, or on one the phone made itself.
  | { kind: 'forced-sign-out'; who: number; tab: Tab; reason: LockReason; fromServer: boolean }
  | { kind: 'own-sign-out'; who: number; tab: Tab }
  | { kind: 'sign-in'; who: number; tab: Tab; role: string }
  | { kind: 'set'; what: 'quota' | 'discardFails' | 'otherWindow' | 'ownsWindow' | 'rowsUnreadable' | 'offline'; on: boolean };

const who = fc.integer({ min: 0, max: PEOPLE.length - 1 });
const tab = fc.constantFrom<Tab>(0, 1);
const reason = fc.constantFrom(...REASONS);
const command: fc.Arbitrary<Command> = fc.oneof(
  // Up to 45 days at a time: the page hidden, the phone in a drawer, or just the next minute.
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('hours' as const), hours: fc.integer({ min: 1, max: 45 * 24 }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('entry' as const), tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('resume' as const), tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('write' as const), who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('gate-refused' as const), who, tab, reason }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('gate-signed-out' as const), who, tab }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('gate-expired' as const), who, tab }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('gate-check' as const), who, tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('gate-open' as const), who, tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('forced-sign-out' as const), who, tab, reason, fromServer: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('own-sign-out' as const), who, tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('sign-in' as const), who, tab, role: fc.constantFrom('estimator', 'owner', 'office') }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('set' as const),
      what: fc.constantFrom('quota' as const, 'discardFails' as const, 'otherWindow' as const, 'ownsWindow' as const, 'rowsUnreadable' as const, 'offline' as const),
      on: fc.boolean(),
    }),
  },
);

describe('any sequence of refusals, sign-outs, sign-ins, days, tabs and failing storage', () => {
  it('hides work locked out for more than 30 days at every entry point, and removes work only when the server refuses the person', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { maxLength: 60 }), async (commands) => {
        phone.reset();
        setClock(START);
        let offline = false;
        const model = new Map<string, Model>(PEOPLE.map((p) => [keyOf(p), { lock: null, row: null, work: false, admitted: false }]));
        const of = (index: number) => ({ p: PEOPLE[index]!, m: model.get(keyOf(PEOPLE[index]!))! });
        const lockedOutTooLong = (m: Model) => m.lock !== null && RETAINED_REASONS.has(m.lock.reason) && clock - m.lock.since > LOCKED_LIMIT_MS;
        const signInCounts = (m: Model) => m.row !== null && sessionValid(m.row, clock);
        const canRemove = () => !phone.discardFails && !(phone.otherWindow && !phone.ownsWindow);

        // The rules.
        // A refusal is saved with its first time; one already saved keeps its time. A refusal that
        // removes work after 30 days is not replaced by a plain "sign in again", and none of them by
        // the sign-in's own age. A write the phone refuses is never saved. True when saved.
        // A hidden lock is kept as it is.
        const refuse = (m: Model, why: SavedReason): boolean => {
          if (lockedOutTooLong(m)) return true;
          if (phone.quota) return false;
          const before = m.lock?.reason;
          const keeps = before !== undefined && RETAINED_REASONS.has(before) && (why === 'sign-in-expired' || (why === 'sign-in-again' && before !== 'sign-in-expired'));
          m.lock = { since: m.lock?.since ?? clock, reason: keeps ? before : why };
          m.admitted = false;
          return true;
        };
        // The server let the person in: their own lock goes, however old. 'unsaved' when the phone
        // could not lift it (nothing may open then).
        const letIn = (m: Model): 'none' | 'unsaved' => {
          if (m.lock !== null && phone.quota) return 'unsaved';
          m.lock = null;
          return 'none';
        };
        // A saved sign-in, judged: past its role's limit the person is locked out from now (false
        // when that cannot be saved); one that counts lifts a lock that only its age had made,
        // unless it is hidden.
        const judge = (m: Model): boolean => {
          if (m.row === null) return true;
          if (!signInCounts(m)) return refuse(m, 'sign-in-expired');
          if (m.lock?.reason === 'sign-in-expired' && !lockedOutTooLong(m) && !phone.quota) m.lock = null;
          return true;
        };
        // An evaluate's sweep: every saved sign-in judged (none when they cannot be read), then the
        // removal the event confirmed: the server refused this person just now while hidden.
        const sweep = (confirmed: string | null): string[] => {
          if (!phone.rowsUnreadable) for (const m of model.values()) judge(m);
          const m = confirmed === null ? null : model.get(confirmed)!;
          if (m === null || !lockedOutTooLong(m) || !canRemove()) return [];
          // Never while their sign-in counts and the server has let them in.
          expect(m.admitted && signInCounts(m)).toBe(false);
          Object.assign(m, { lock: null, work: false });
          return [confirmed!];
        };
        // What the code removed against what the rules say: exactly that, and nobody else's work.
        const expectRemoved = async (expected: string[], run: () => Promise<string[]>) => {
          const workBefore = new Set(phone.work);
          const removed = await run();
          expect([...removed].sort()).toEqual([...expected].sort());
          for (const kept of workBefore) expect(phone.work.has(kept)).toBe(!expected.includes(kept));
        };
        // A sign-out, the refusal first when the app makes it on one, then the saved sign-in judged
        // before it goes; each step runs a sweep, and so does the entry point that follows.
        const signOut = async (p: FieldPerson, m: Model, t: Tab, run: () => Promise<void>, refusal?: { why: LockReason; fromServer: boolean }) => {
          const gone: string[] = [];
          const ok = (() => {
            if (refusal) {
              const saved = refuse(m, refusal.why);
              gone.push(...sweep(saved && refusal.fromServer && lockedOutTooLong(m) ? keyOf(p) : null));
              if (!saved) return false;
            }
            const judged = judge(m);
            gone.push(...sweep(null));
            return judged;
          })();
          // The row goes before the entry point that follows.
          if (ok) m.row = null;
          gone.push(...sweep(null));
          const removed: string[] = [];
          const stop = TABS[t]!.onWorkRemoved((person) => removed.push(person));
          await expectRemoved(gone, async () => {
            const outcome = await run().then(
              () => 'signed-out',
              (error: unknown) => (error instanceof TABS[t]!.WorkNotSecuredError ? 'not-secured' : 'failed'),
            );
            await TABS[t]!.evaluate(clock, { kind: 'entry' }).done;
            // The saved sign-in goes only once the phone holds what it must.
            expect(outcome).toBe(ok ? 'signed-out' : 'not-secured');
            expect(phone.rows.has(keyOf(p))).toBe(!ok);
            return removed;
          });
          stop();
        };
        const refusedBy = async (p: FieldPerson, m: Model, t: Tab, why: SavedReason, fromServer: boolean) => {
          const saved = refuse(m, why);
          const result = TABS[t]!.evaluate(clock, { kind: 'refused', person: p, reason: why, fromServer });
          expect(result.state).toBe(!saved ? 'unsaved' : lockedOutTooLong(m) ? 'hidden' : 'locked');
          await expectRemoved(sweep(saved && fromServer && lockedOutTooLong(m) ? keyOf(p) : null), () => result.done);
        };

        for (const step of commands) {
          if (step.kind === 'hours') setClock(clock + step.hours * 60 * 60 * 1000);
          else if (step.kind === 'set') {
            if (step.what === 'offline') offline = step.on;
            else phone[step.what] = step.on;
            // One window holds the lock: this page's field window, or another tab's.
            if (step.on && step.what === 'otherWindow') phone.ownsWindow = false;
            if (step.on && step.what === 'ownsWindow') phone.otherWindow = false;
          } else if (step.kind === 'entry' || step.kind === 'resume') {
            const event = step.kind === 'entry' ? ({ kind: 'entry' } as const) : ({ kind: 'entry', company: { tenantId: 't-a', config } } as const);
            await expectRemoved(sweep(null), () => TABS[step.tab]!.evaluate(clock, event).done);
          } else if (step.kind === 'write') {
            // The shell lets a person work only with a sign-in that counts and no lock.
            const { p, m } = of(step.who);
            if (!signInCounts(m) || m.lock !== null) continue;
            if (noteWrite(p.tenantId, p.uid, clock) !== null) {
              phone.work.add(keyOf(p));
              m.work = true;
            }
          } else if (step.kind === 'gate-refused') {
            const { p, m } = of(step.who);
            if (m.row === null || offline) continue;
            await refusedBy(p, m, step.tab, step.reason, true);
          } else if (step.kind === 'gate-signed-out') {
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            await refusedBy(p, m, step.tab, 'sign-in-again', false);
          } else if (step.kind === 'gate-expired') {
            const { p, m } = of(step.who);
            if (m.row === null || signInCounts(m)) continue;
            await refusedBy(p, m, step.tab, 'sign-in-expired', false);
          } else if (step.kind === 'gate-check') {
            // Any other check of the gate: the saved sign-in it runs from is judged, then the sweep.
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            const judged = judge(m);
            const result = TABS[step.tab]!.evaluate(clock, { kind: 'entry', person: p, saved: m.row });
            expect(result.state).toBe(!judged ? 'unsaved' : lockedOutTooLong(m) ? 'hidden' : m.lock === null ? 'none' : 'locked');
            await expectRemoved(sweep(null), () => result.done);
          } else if (step.kind === 'gate-open' || step.kind === 'sign-in') {
            // The server lets the person in: from an open shell's gate, or on the sign-in page,
            // where the row is saved first. Nothing opens unless the lock is lifted.
            const { p, m } = of(step.who);
            if (offline) continue;
            if (step.kind === 'sign-in') {
              saveRow(p, step.role, clock);
              m.row = { role: step.role, authTime: clock };
            } else if (!signInCounts(m)) continue;
            const expected = letIn(m);
            const result = TABS[step.tab]!.evaluate(clock, { kind: 'let-in', person: p });
            expect(result.state).toBe(expected);
            if (expected === 'none') m.admitted = true;
            await expectRemoved(sweep(null), () => result.done);
          } else if (step.kind === 'forced-sign-out') {
            const { p, m } = of(step.who);
            if (m.row === null || (offline && step.fromServer)) continue;
            const t = step.tab;
            await signOut(p, m, t, () => TABS[t]!.signOutOnRefusal(authFor(p), p.tenantId, config, step.reason, step.fromServer), {
              why: step.reason,
              fromServer: step.fromServer,
            });
          } else {
            // The person's own sign-out (Keep).
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            const t = step.tab;
            await signOut(p, m, t, () => TABS[t]!.signOutKeeping(authFor(p), p.tenantId));
          }

          // After every step the phone holds exactly what the rules say, and work locked out for
          // more than 30 days is hidden: read from the lock and the clock alone.
          for (const p of PEOPLE) {
            const m = model.get(keyOf(p))!;
            expect(lockOf(p), `${keyOf(p)} lock after ${JSON.stringify(step)}`).toEqual(m.lock);
            expect(phone.work.has(keyOf(p)), `${keyOf(p)} work after ${JSON.stringify(step)}`).toBe(m.work);
            expect(phone.rows.has(keyOf(p))).toBe(m.row !== null);
            expect(lockOutlived(p.tenantId, p.uid, clock)).toBe(lockedOutTooLong(m));
          }
        }

        // Whatever happened, once storage answers and no other window holds the work, the server
        // refusing each person removes exactly the work that is hidden, in either tab.
        phone.quota = phone.discardFails = phone.otherWindow = phone.rowsUnreadable = false;
        for (const [index, p] of PEOPLE.entries()) await refusedBy(p, model.get(keyOf(p))!, (index % 2) as Tab, 'session-revoked', true);
        for (const p of PEOPLE) {
          const m = model.get(keyOf(p))!;
          expect(phone.work.has(keyOf(p)) && lockedOutTooLong(m)).toBe(false);
        }
      }),
      {
        numRuns: 400,
        examples: [
          // A refusal on day 0 the phone cannot save; storage answers again; the page comes back on
          // day 31: nothing is locked by the phone alone, so nothing is hidden or removed.
          [
            [
              { kind: 'sign-in', who: 0, tab: 0, role: 'estimator' },
              { kind: 'write', who: 0 },
              { kind: 'set', what: 'quota', on: true },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'company-inactive' },
              { kind: 'hours', hours: 31 * 24 },
              { kind: 'set', what: 'quota', on: false },
              { kind: 'entry', tab: 0 },
            ],
          ],
          // An owner past 14 days chooses Keep on a full phone in one tab; 29 days later the owner
          // signs in in another tab, works there and chooses Keep there too; the first tab comes
          // back 2 days later: the owner's kept work stays.
          [
            [
              { kind: 'sign-in', who: 0, tab: 0, role: 'owner' },
              { kind: 'write', who: 0 },
              { kind: 'hours', hours: 15 * 24 },
              { kind: 'set', what: 'quota', on: true },
              { kind: 'own-sign-out', who: 0, tab: 0 },
              { kind: 'set', what: 'quota', on: false },
              { kind: 'hours', hours: 29 * 24 },
              { kind: 'sign-in', who: 0, tab: 1, role: 'owner' },
              { kind: 'write', who: 0 },
              { kind: 'own-sign-out', who: 0, tab: 1 },
              { kind: 'hours', hours: 2 * 24 },
              { kind: 'resume', tab: 0 },
            ],
          ],
          // Refused on day 0, hidden from day 31 at every entry point and in both tabs; a refusal the
          // phone makes removes nothing; the server's refusal does.
          [
            [
              { kind: 'sign-in', who: 0, tab: 0, role: 'estimator' },
              { kind: 'write', who: 0 },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'session-revoked' },
              { kind: 'hours', hours: 31 * 24 },
              { kind: 'entry', tab: 1 },
              { kind: 'gate-signed-out', who: 0, tab: 1 },
              { kind: 'resume', tab: 0 },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'session-revoked' },
            ],
          ],
          // Hidden, then the server lets the person in: their own work shows again.
          [
            [
              { kind: 'sign-in', who: 0, tab: 0, role: 'estimator' },
              { kind: 'write', who: 0 },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'member-disabled' },
              { kind: 'hours', hours: 31 * 24 },
              { kind: 'sign-in', who: 0, tab: 1, role: 'estimator' },
              { kind: 'entry', tab: 0 },
            ],
          ],
        ],
      },
    );
  });
});
