import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import type { FieldPerson } from '@/lib/field-db';
import type { DsMe } from '@/lib/field/ds-me';
import type { LockReason, SavedReason } from '@/lib/field/unsent';

// S6-3b: the phone's one retention routine, evaluate(now, event) in src/lib/field/retention.ts.
// The examples are the paths three reviews found uncovered; the properties run random sequences of
// refusals, sign-outs, sign-ins, days passing, the phone opening, storage that refuses and another
// window holding the work, and check the two things the owner asked for after every step:
//   - unsent work of someone locked out for more than 30 days does not survive the next entry
//     point (while the phone's storage refuses the removal it stays locked and is never sent, and
//     it goes at the next entry point where storage answers);
//   - nobody's work is removed while they are not locked out for more than 30 days.
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

const { cleanupKey, evaluate, forgetPending, onWorkRemoved, takeRemoved, watchRetention, WATCH_EVERY_MS } = await import('@/lib/field/retention');
const { signOutKeeping, signOutOnRefusal, WorkNotSecuredError } = await import('@/lib/field/sign-out');
const { sessionValid } = await import('@/lib/field/sync-gate');
const { RETAINED_REASONS, noteWrite, readUnsent, unsentKey } = await import('@/lib/field/unsent');
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
  forgetPending();
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

  it('locked for more than 30 days is expired: no later refusal and no let-in makes the work sendable, and the next evaluate removes it', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'session-revoked' });
    const later = START + LOCKED_LIMIT_MS + 1;
    phone.otherWindow = true;

    // Another window holds the work, so it cannot go yet. It stays expired through a refusal of a
    // kind that is not removed after 30 days, and through the server letting the person in.
    const refusedAgain = evaluate(later, { kind: 'refused', person: ana, reason: 'account-disabled' });
    expect(refusedAgain.state).toBe('expired');
    expect(await refusedAgain.done).toEqual([]);
    const letIn = evaluate(later, { kind: 'let-in', person: ana });
    expect(letIn.state).toBe('expired');
    expect(await letIn.done).toEqual([]);
    expect(lockOf(ana)).toEqual({ since: START, reason: 'session-revoked' });
    expect(phone.work.has(keyOf(ana))).toBe(true);

    phone.otherWindow = false;
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual(['t-a/ana']);
    expect(phone.work.has(keyOf(ana))).toBe(false);
    expect(evaluate(later, { kind: 'entry', person: ana }).state).toBe('none');
  });

  it('a refusal that is not removed after 30 days never expires', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'second-step' });
    const much = evaluate(START + 400 * DAY, { kind: 'entry', person: ana });
    expect(much.state).toBe('locked');
    expect(await much.done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });

  it('says "unsaved", and changes nothing, when the phone cannot save a refusal', () => {
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
    await expect(signOutOnRefusal(authFor(ana), 't-a', config, 'sign-in-again')).rejects.toBeInstanceOf(WorkNotSecuredError);
    expect(phone.rows.has(keyOf(ana))).toBe(true);
    expect(lockOf(ana)).toEqual({ since: START, reason: 'second-step' });

    // Room again: the refusal is saved and the 30 days run.
    phone.quota = false;
    await signOutOnRefusal(authFor(ana), 't-a', config, 'sign-in-again');
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-again' });
    expect(phone.rows.has(keyOf(ana))).toBe(false);
    expect(await evaluate(START + LOCKED_LIMIT_MS + 1, { kind: 'entry' }).done).toEqual(['t-a/ana']);
  });

  it('holds a refusal it could not save, keeps the work closed, and saves it at the next evaluate once storage answers', async () => {
    giveWork(ana, START);
    phone.quota = true;
    expect(evaluate(START, { kind: 'refused', person: ana, reason: 'company-inactive' }).state).toBe('unsaved');
    expect(evaluate(START + DAY, { kind: 'entry', person: ana }).state).toBe('locked');
    expect(lockOf(ana)).toBeNull();

    phone.quota = false;
    await evaluate(START + 2 * DAY, { kind: 'entry' }).done;
    expect(lockOf(ana)).toEqual({ since: START + 2 * DAY, reason: 'company-inactive' });
    expect(await evaluate(START + 2 * DAY + LOCKED_LIMIT_MS + 1, { kind: 'entry' }).done).toEqual(['t-a/ana']);
  });

  it('drops a held refusal once the person is let in, or the sign-in it was given for is no longer current', async () => {
    giveWork(ana, START);
    giveWork(ben, START);
    phone.quota = true;
    let current = true;
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    evaluate(START, { kind: 'refused', person: ben, reason: 'sign-in-again', current: () => current });
    expect(evaluate(START, { kind: 'let-in', person: ana }).state).toBe('none');
    current = false;
    phone.quota = false;
    await evaluate(START, { kind: 'entry' }).done;
    expect(lockOf(ana)).toBeNull();
    expect(lockOf(ben)).toBeNull();
    expect(evaluate(START, { kind: 'entry', person: ben }).state).toBe('none');
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

    // Reopened again and again with no signal, the first time stays; 30 days on, the work goes.
    await evaluate(START + 10 * DAY, { kind: 'entry' }).done;
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-expired' });
    expect(await evaluate(START + LOCKED_LIMIT_MS + 1, { kind: 'entry' }).done).toEqual(['t-a/ana', 't-a/ben']);
    expect(phone.work.has(keyOf(otherAna))).toBe(true);
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
    // was lifted). By then the other Ana has been locked out for 40 days.
    const later = START + 20 * DAY;
    for (const who of [ana, ben, otherAna]) saveRow(who, 'estimator', later - DAY);
    phone.otherWindow = true;
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual([]);
    expect(lockOf(ana)).toBeNull();
    expect(lockOf(ben)).toEqual({ since: START, reason: 'sign-in-again' });
    expect(lockOf(otherAna)).toEqual({ since: START - 20 * DAY, reason: 'sign-in-expired' });
    expect(phone.work.has(keyOf(ana))).toBe(true);

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

  it('removes everyone\'s outlived work, in every company, whoever the event was about, with no saved sign-in', async () => {
    for (const who of [ana, ben, otherAna]) {
      giveWork(who, START);
      evaluate(START, { kind: 'refused', person: who, reason: 'sign-in-again' });
    }
    evaluate(START + 20 * DAY, { kind: 'let-in', person: ben });
    const removed: string[] = [];
    const stop = onWorkRemoved((who) => removed.push(who));

    const later = START + LOCKED_LIMIT_MS + 1;
    expect(await evaluate(later, { kind: 'refused', person: ben, reason: 'member-disabled' }).done).toEqual(['t-a/ana', 't-b/ana']);
    expect(removed).toEqual(['t-a/ana', 't-b/ana']);
    expect([...phone.work]).toEqual(['t-a/ben']);
    expect(lockOf(ben)).toEqual({ since: later, reason: 'member-disabled' });
    stop();
  });

  it('removes from the field window itself with the lock it holds, and from any other page only when no field window is open', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'company-inactive' });
    const later = START + LOCKED_LIMIT_MS + 1;

    phone.otherWindow = true;
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual([]);
    expect(phone.discards.at(-1)).toEqual({ person: 't-a/ana', lockHeld: false });
    phone.otherWindow = false;
    phone.ownsWindow = true;
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual(['t-a/ana']);
    expect(phone.discards.at(-1)).toEqual({ person: 't-a/ana', lockHeld: true });
  });

  it('tries a removal the phone\'s storage refused again at the next evaluate', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    const later = START + LOCKED_LIMIT_MS + 1;
    phone.discardFails = true;
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual([]);
    const still = evaluate(later, { kind: 'entry', person: ana });
    expect(still.state).toBe('expired');
    expect(await still.done).toEqual([]);
    phone.discardFails = false;
    expect(await evaluate(later + 1, { kind: 'entry' }).done).toEqual(['t-a/ana']);
  });

  it('runs one removal at a time: two evaluates at once remove a person once', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    const later = START + LOCKED_LIMIT_MS + 1;
    const [first, second] = await Promise.all([evaluate(later, { kind: 'entry' }).done, evaluate(later, { kind: 'entry' }).done]);
    expect([first, second]).toEqual([['t-a/ana'], []]);
    expect(phone.discards).toHaveLength(1);
  });

  it('removes nothing on a guess: not for a mark it cannot read, nor without the settings that name the database', async () => {
    const later = START + LOCKED_LIMIT_MS + 1;
    phone.items.set(unsentKey('t-a', 'ana'), '{not json');
    // A lock an earlier version saved without the company's settings, and no saved sign-in.
    phone.items.set(unsentKey('t-a', 'ben'), JSON.stringify({ writes: 1, unsentSince: START, lockedSince: START, lockedReason: 'sign-in-again' }));
    phone.work.add(keyOf(ben));
    expect(await evaluate(later, { kind: 'entry' }).done).toEqual([]);
    expect(phone.discards).toEqual([]);

    // Anyone of the company (here the sign-in page, or a person's own event) brings the settings;
    // then the work with a readable lock can go. The mark that cannot be read stays, locked.
    const unread = evaluate(later, { kind: 'entry', person: ana });
    expect(unread.state).toBe('locked');
    expect(await unread.done).toEqual(['t-a/ben']);
    expect(await evaluate(later, { kind: 'entry', company: { tenantId: 't-a', config } }).done).toEqual([]);
    expect(phone.discards).toEqual([{ person: 't-a/ben', lockHeld: false }]);
    expect(phone.items.get(unsentKey('t-a', 'ana'))).toBe('{not json');
  });

  it('keeps the settings a company\'s own page brings, for a lock saved without them', async () => {
    const later = START + LOCKED_LIMIT_MS + 1;
    phone.items.set(unsentKey('t-a', 'ben'), JSON.stringify({ writes: 1, unsentSince: START, lockedSince: START, lockedReason: 'sign-in-again' }));
    phone.work.add(keyOf(ben));
    expect(await evaluate(later, { kind: 'entry', company: { tenantId: 't-b', config } }).done).toEqual([]);
    expect(await evaluate(later, { kind: 'entry', company: { tenantId: 't-a', config } }).done).toEqual(['t-a/ben']);
  });
});

describe('a sign-out the app makes on a refusal', () => {
  it('removes work already past the limit before the saved sign-in goes', async () => {
    saveRow(ana, 'estimator', START);
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    setClock(START + LOCKED_LIMIT_MS + 1);
    await signOutOnRefusal(authFor(ana), 't-a', config, 'sign-in-again');
    expect(phone.log).toEqual(['removed t-a/ana', 'forgot t-a/ana']);
    expect(phone.work.has(keyOf(ana))).toBe(false);
    expect(phone.rows.has(keyOf(ana))).toBe(false);
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
    expect(await evaluate(keep + LOCKED_LIMIT_MS, { kind: 'entry' }).done).toEqual([]);
    expect(await evaluate(keep + LOCKED_LIMIT_MS + 1, { kind: 'entry' }).done).toEqual(['t-a/ana']);
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
  // Ana's work, locked on day 0; the page opens on day 29.
  function lockedOnDay29() {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    setClock(START + 29 * DAY);
  }

  it.each([
    ['made visible again', (shown: ReturnType<typeof page>) => shown.fire('visibilitychange')],
    ['brought back from the back-forward cache', (shown: ReturnType<typeof page>) => shown.fire('pageshow')],
    ['left open and shown, at the next minute', () => vi.advanceTimersByTime(WATCH_EVERY_MS)],
  ])('run the routine as the page opens and when it is %s', async (_name, again) => {
    vi.useFakeTimers();
    const shown = page();
    lockedOnDay29();
    const stop = watchRetention();
    await settle();
    expect(phone.work.has(keyOf(ana))).toBe(true);

    // Two days pass with the page hidden: nothing runs while it is.
    setClock(START + 31 * DAY);
    shown.document.visibilityState = 'hidden';
    again(shown);
    await settle();
    expect(phone.work.has(keyOf(ana))).toBe(true);

    shown.document.visibilityState = 'visible';
    again(shown);
    await settle();
    expect(phone.work.has(keyOf(ana))).toBe(false);
    stop();
  });

  it('remove work that outlived the limit while the page was closed, as it opens', async () => {
    page();
    lockedOnDay29();
    setClock(START + 31 * DAY);
    const stop = watchRetention();
    await settle();
    expect(phone.work.has(keyOf(ana))).toBe(false);
    // The person's shell, started after it went, is still told, once.
    expect(takeRemoved('t-a/ana')).toBe(true);
    expect(takeRemoved('t-a/ana')).toBe(false);
    stop();
  });

  it('keep the settings of the company whose page it is, and stop when told to', async () => {
    vi.useFakeTimers();
    const shown = page();
    lockedOnDay29();
    const stop = watchRetention({ tenantId: 't-b', config });
    await settle();
    expect(phone.items.has(cleanupKey('t-b'))).toBe(true);
    stop();
    setClock(START + 31 * DAY);
    shown.fire('visibilitychange');
    shown.fire('pageshow');
    vi.advanceTimersByTime(10 * WATCH_EVERY_MS);
    await settle();
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });
});

// The model: what the owner's rules say each person's lock, saved sign-in and work must be, written
// from the rules (docs/plans/S6.md, O5) and not from the code under test.
// `admitted`: the server let them in, and the lock was lifted, since they were last locked out.
// `pending`: a refusal the phone could not save, held by the page and told again at every evaluate.
type Model = {
  lock: { since: number; reason: SavedReason } | null;
  row: { role: string; authTime: number } | null;
  work: boolean;
  admitted: boolean;
  pending: SavedReason | null;
};
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

type Command =
  | { kind: 'hours'; hours: number }
  | { kind: 'entry' }
  | { kind: 'write'; who: number }
  | { kind: 'gate-refused'; who: number; reason: LockReason }
  | { kind: 'gate-expired'; who: number }
  | { kind: 'gate-check'; who: number }
  | { kind: 'gate-open'; who: number }
  | { kind: 'forced-sign-out'; who: number; reason: LockReason }
  | { kind: 'own-sign-out'; who: number }
  | { kind: 'sign-in'; who: number; role: string }
  | { kind: 'set'; what: 'quota' | 'discardFails' | 'otherWindow' | 'ownsWindow' | 'rowsUnreadable' | 'offline'; on: boolean };

const who = fc.integer({ min: 0, max: PEOPLE.length - 1 });
const reason = fc.constantFrom(...REASONS);
const command: fc.Arbitrary<Command> = fc.oneof(
  // Up to 45 days at a time: the page hidden, the phone in a drawer, or just the next minute.
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('hours' as const), hours: fc.integer({ min: 1, max: 45 * 24 }) }) },
  { weight: 5, arbitrary: fc.constant({ kind: 'entry' as const }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('write' as const), who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('gate-refused' as const), who, reason }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('gate-expired' as const), who }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('gate-check' as const), who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('gate-open' as const), who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('forced-sign-out' as const), who, reason }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('own-sign-out' as const), who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('sign-in' as const), who, role: fc.constantFrom('estimator', 'owner', 'office') }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('set' as const),
      what: fc.constantFrom('quota' as const, 'discardFails' as const, 'otherWindow' as const, 'ownsWindow' as const, 'rowsUnreadable' as const, 'offline' as const),
      on: fc.boolean(),
    }),
  },
);

describe('any sequence of refusals, sign-outs, sign-ins, days and failing storage', () => {
  it('never keeps work locked out for more than 30 days past a working entry point, never sends it, and never removes anyone else\'s', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { maxLength: 60 }), async (commands) => {
        phone.reset();
        forgetPending();
        setClock(START);
        let offline = false;
        const model = new Map<string, Model>(PEOPLE.map((p) => [keyOf(p), { lock: null, row: null, work: false, admitted: false, pending: null }]));
        const of = (index: number) => ({ p: PEOPLE[index]!, m: model.get(keyOf(PEOPLE[index]!))! });
        const lockedOutTooLong = (m: Model) => m.lock !== null && RETAINED_REASONS.has(m.lock.reason) && clock - m.lock.since > LOCKED_LIMIT_MS;
        const signInCounts = (m: Model) => m.row !== null && sessionValid(m.row, clock);
        const canRemove = () => !phone.discardFails && !(phone.otherWindow && !phone.ownsWindow);

        // The rules. True when the phone holds the person's lock afterwards.
        // The first refusal's time stands. A refusal that removes work after 30 days is not
        // replaced by a plain "sign in again", and none of them by the sign-in's own age.
        // A write the phone refuses is never saved. Work past the limit needs nothing new: its
        // company's settings were kept with its lock.
        const refuse = (m: Model, why: SavedReason): boolean => {
          if (lockedOutTooLong(m)) return true;
          if (phone.quota) return false;
          const before = m.lock?.reason;
          const keeps = before !== undefined && RETAINED_REASONS.has(before) && (why === 'sign-in-expired' || (why === 'sign-in-again' && before !== 'sign-in-expired'));
          m.lock = { since: m.lock?.since ?? clock, reason: keeps ? before : why };
          m.admitted = false;
          return true;
        };
        // The server let the person in: the lock goes, unless the work is past the limit. What it
        // answers: 'unsaved' when the phone could not lift the lock (nothing may open then).
        const letIn = (m: Model): 'none' | 'expired' | 'unsaved' => {
          if (lockedOutTooLong(m)) return 'expired';
          if (m.lock !== null && phone.quota) return 'unsaved';
          m.lock = null;
          return 'none';
        };
        // A saved sign-in, judged: past its role's limit the person is locked out from now; one
        // that counts again lifts a lock that only its age had made.
        // False when the lock it needs cannot be saved.
        const judge = (m: Model): boolean => {
          if (m.row === null) return true;
          if (!signInCounts(m)) return refuse(m, 'sign-in-expired');
          if (m.lock?.reason === 'sign-in-expired') letIn(m);
          return true;
        };
        // A refusal the phone could not save is told again at the start of every evaluate; a let-in
        // for the person drops it.
        const retryHeld = () => {
          for (const m of model.values()) if (m.pending && refuse(m, m.pending)) m.pending = null;
        };
        const told = (m: Model, why: SavedReason): boolean => {
          retryHeld();
          const saved = refuse(m, why);
          m.pending = saved ? null : why;
          return saved;
        };
        // What every entry point owes: who must be gone after it, and who may be.
        const expectSweep = async (run: () => Promise<string[]>) => {
          if (!phone.rowsUnreadable) for (const m of model.values()) judge(m);
          const due = PEOPLE.filter((p) => lockedOutTooLong(model.get(keyOf(p))!)).map(keyOf);
          const workBefore = new Set(phone.work);
          const removed = await run();
          // Nobody's work goes unless they have been locked out for more than 30 days.
          for (const gone of removed) expect(due).toContain(gone);
          // Nor while their sign-in counts and the server has let them in.
          for (const gone of removed) expect(model.get(gone)!.admitted && signInCounts(model.get(gone)!)).toBe(false);
          for (const kept of workBefore) if (!due.includes(kept)) expect(phone.work.has(kept)).toBe(true);
          // Everybody's who has been does, at this entry point, when the phone can remove it.
          if (canRemove()) {
            expect([...removed].sort()).toEqual([...due].sort());
            for (const gone of due) expect(phone.work.has(gone)).toBe(false);
            for (const gone of due) Object.assign(model.get(gone)!, { lock: null, work: false });
          } else {
            expect(removed).toEqual([]);
          }
        };

        for (const step of commands) {
          if (step.kind === 'hours') setClock(clock + step.hours * 60 * 60 * 1000);
          else if (step.kind === 'set') {
            if (step.what === 'offline') offline = step.on;
            else phone[step.what] = step.on;
            // One window holds the lock: this page's field window, or another tab's.
            if (step.on && step.what === 'otherWindow') phone.ownsWindow = false;
            if (step.on && step.what === 'ownsWindow') phone.otherWindow = false;
          } else if (step.kind === 'entry') {
            retryHeld();
            await expectSweep(() => evaluate(clock, { kind: 'entry' }).done);
          }
          else if (step.kind === 'write') {
            // The shell lets a person work only with a sign-in that counts and no lock, saved or held.
            const { p, m } = of(step.who);
            if (!signInCounts(m) || m.lock !== null || m.pending !== null) continue;
            if (noteWrite(p.tenantId, p.uid, clock) !== null) {
              phone.work.add(keyOf(p));
              m.work = true;
            }
          } else if (step.kind === 'gate-refused' || step.kind === 'gate-expired') {
            // The sync gate of an open field shell: the server's refusal, or a saved sign-in found
            // past its role's limit with or without signal.
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            if (step.kind === 'gate-refused' ? offline : signInCounts(m)) continue;
            const why = step.kind === 'gate-refused' ? step.reason : 'sign-in-expired';
            const saved = told(m, why);
            const result = evaluate(clock, { kind: 'refused', person: p, reason: why });
            expect(result.state).toBe(!saved ? 'unsaved' : lockedOutTooLong(m) ? 'expired' : 'locked');
            await expectSweep(() => result.done);
          } else if (step.kind === 'gate-check') {
            // Any other check of the gate (every minute, the page shown again, an answer that
            // opens nothing): the saved sign-in it runs from is judged, then the phone is swept.
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            retryHeld();
            const judged = judge(m);
            const result = evaluate(clock, { kind: 'entry', person: p, saved: m.row });
            expect(result.state).toBe(!judged ? 'unsaved' : lockedOutTooLong(m) ? 'expired' : m.lock === null && m.pending === null ? 'none' : 'locked');
            await expectSweep(() => result.done);
          } else if (step.kind === 'gate-open') {
            // The server lets the person in; the gate opens the network unless told 'expired'.
            const { p, m } = of(step.who);
            if (offline || !signInCounts(m)) continue;
            m.pending = null;
            retryHeld();
            const expected = letIn(m);
            const result = evaluate(clock, { kind: 'let-in', person: p });
            // Work locked out for more than 30 days is never sent, and nothing opens while the
            // phone cannot save that the lock is lifted.
            expect(result.state).toBe(expected);
            if (expected === 'none') m.admitted = true;
            await expectSweep(() => result.done);
          } else if (step.kind === 'forced-sign-out') {
            // A screen ends the sign-in on the server's refusal.
            const { p, m } = of(step.who);
            if (offline || m.row === null) continue;
            const saved = told(m, step.reason);
            const removed: string[] = [];
            const stop = onWorkRemoved((gone) => removed.push(gone));
            const outcome = await signOutOnRefusal(authFor(p), p.tenantId, config, step.reason).then(
              () => 'signed-out',
              (error: unknown) => (error instanceof WorkNotSecuredError ? 'not-secured' : 'failed'),
            );
            // The saved sign-in goes only once the refusal is saved.
            expect(outcome).toBe(saved ? 'signed-out' : 'not-secured');
            expect(phone.rows.has(keyOf(p))).toBe(!saved);
            // Either way the phone was swept, for everyone.
            await expectSweep(async () => {
              await evaluate(clock, { kind: 'entry' }).done;
              return removed;
            });
            stop();
            if (saved) m.row = null;
          } else if (step.kind === 'own-sign-out') {
            // Keep: the saved sign-in is judged before it goes, and stays when the lock it needs
            // cannot be saved.
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            retryHeld();
            const judged = judge(m);
            const removed: string[] = [];
            const stop = onWorkRemoved((gone) => removed.push(gone));
            const outcome = await signOutKeeping(authFor(p), p.tenantId).then(
              () => 'signed-out',
              (error: unknown) => (error instanceof WorkNotSecuredError ? 'not-secured' : 'failed'),
            );
            expect(outcome).toBe(judged ? 'signed-out' : 'not-secured');
            expect(phone.rows.has(keyOf(p))).toBe(!judged);
            await expectSweep(async () => {
              await evaluate(clock, { kind: 'entry' }).done;
              return removed;
            });
            stop();
            if (judged) m.row = null;
          } else {
            // The sign-in page: the row is saved, then the server's "signed in" lifts the lock.
            const { p, m } = of(step.who);
            if (offline) continue;
            saveRow(p, step.role, clock);
            m.row = { role: step.role, authTime: clock };
            m.pending = null;
            retryHeld();
            const expected = letIn(m);
            const result = evaluate(clock, { kind: 'let-in', person: p });
            // The page offers the field app only once the lock is lifted.
            expect(result.state).toBe(expected);
            if (expected === 'none') m.admitted = true;
            await expectSweep(() => result.done);
          }

          // After every step the phone holds exactly what the rules say.
          for (const p of PEOPLE) {
            const m = model.get(keyOf(p))!;
            expect(lockOf(p), `${keyOf(p)} lock after ${JSON.stringify(step)}`).toEqual(m.lock);
            expect(phone.work.has(keyOf(p)), `${keyOf(p)} work after ${JSON.stringify(step)}`).toBe(m.work);
            expect(phone.rows.has(keyOf(p))).toBe(m.row !== null);
          }
        }

        // Whatever happened, once the phone's storage answers and no other window holds the work,
        // one entry point leaves nothing of anyone locked out for more than 30 days.
        phone.quota = phone.discardFails = phone.otherWindow = phone.rowsUnreadable = false;
        retryHeld();
        await expectSweep(() => evaluate(clock, { kind: 'entry' }).done);
        for (const p of PEOPLE) {
          const m = model.get(keyOf(p))!;
          expect(phone.work.has(keyOf(p)) && lockedOutTooLong(m)).toBe(false);
        }
      }),
      { numRuns: 400 },
    );
  });
});
