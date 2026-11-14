import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// S6-3b: the phone's one retention routine, evaluate(now, event) in src/lib/field/retention.ts, on
// the paths the reviews found. The owner's rules (decisions 010, 011): work of someone locked out for
// more than 30 days is hidden (never shown or opened offline) at every entry point, read from the
// lock and the clock alone; work is removed only when the server, in the operation that removes,
// says the person or the company is refused or removed. Random sequences of the same events are in
// retention-property.test.ts; the phone they run on is retention-phone.ts.

const helper = await vi.hoisted(async () => import('./retention-phone'));
vi.mock('@/lib/field/ds-me', async (original) => helper.dsMe(await original<typeof import('@/lib/field/ds-me')>()));
vi.mock('@/lib/firebase-client', () => ({ signOutCompany: async () => undefined }));
vi.mock('@/lib/field/window-lock', () => ({ holdsWindow: () => helper.phone.ownsWindow }));
vi.mock('@/lib/field-db', () => helper.fieldDb());

const { DAY, START, config, keyOf, phone, storage, ana, ben, otherAna, saveRow, giveWork, lockOf, authFor } = helper;
const { cleanupKey, contentHidden, evaluate, forgetPending, onWorkRemoved, takeRemoved, watchRetention, WATCH_EVERY_MS } = await import('@/lib/field/retention');
const { signOutKeeping, signOutOnRefusal, WorkNotSecuredError } = await import('@/lib/field/sign-out');
// A second tab: its own copy of the routine's modules, over the same storage and saved sign-ins.
vi.resetModules();
const secondTab = { ...(await import('@/lib/field/retention')), ...(await import('@/lib/field/sign-out')) };
const TABS = [{ evaluate }, secondTab];
const { lockOutlived, noteWrite, unsentKey } = await import('@/lib/field/unsent');
// O5: 30 days, said here and not read from the code under test.
const LOCKED_LIMIT_MS = 30 * DAY;

const setClock = (now: number) => vi.setSystemTime(now);

beforeEach(() => {
  phone.reset();
  forgetPending();
  secondTab.forgetPending();
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

  it('locked for more than 30 days is hidden: only the server saying, just now, that she is removed takes the work away', async () => {
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

    // The server asks her to sign in again: no word that she is removed, so it only hides.
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'session-revoked', fromServer: true }).done).toEqual([]);
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'sign-in-again', fromServer: true }).done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
    // The server says her account is turned off while another window holds the work: it cannot go yet.
    phone.otherWindow = true;
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'account-disabled', fromServer: true }).done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
    phone.otherWindow = false;
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'account-disabled', fromServer: true }).done).toEqual(['t-a/ana']);
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
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'sign-in-again', fromServer: true }).done).toEqual([]);
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'member-disabled', fromServer: true }).done).toEqual(['t-a/ana']);
  });

  it('holds a refusal it could not save with its time: the work stays closed, and is hidden from day 30 of the refusal, never removed by the replay', async () => {
    giveWork(ana, START);
    phone.quota = true;
    expect(evaluate(START, { kind: 'refused', person: ana, reason: 'company-inactive', fromServer: true }).state).toBe('unsaved');
    expect(evaluate(START + DAY, { kind: 'entry', person: ana }).state).toBe('locked');
    expect(lockOf(ana)).toBeNull();

    // Storage answers again on day 31: the refusal is saved with its own time, so the work is hidden
    // at once, and kept.
    phone.quota = false;
    expect(await evaluate(START + 31 * DAY, { kind: 'entry' }).done).toEqual([]);
    expect(lockOf(ana)).toEqual({ since: START, reason: 'company-inactive' });
    expect(evaluate(START + 31 * DAY, { kind: 'entry', person: ana }).state).toBe('hidden');
    expect(phone.work.has(keyOf(ana))).toBe(true);
    // The server's own answer, now, removes it.
    expect(await evaluate(START + 31 * DAY, { kind: 'refused', person: ana, reason: 'company-inactive', fromServer: true }).done).toEqual(['t-a/ana']);
  });

  it('a let-in drops what this page holds for the person', async () => {
    giveWork(ana, START);
    phone.quota = true;
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    phone.quota = false;
    expect(evaluate(START + DAY, { kind: 'let-in', person: ana }).state).toBe('none');
    expect(lockOf(ana)).toBeNull();
    expect(await evaluate(START + 31 * DAY, { kind: 'entry' }).done).toEqual([]);
    expect(lockOf(ana)).toBeNull();
    expect(evaluate(START + 31 * DAY, { kind: 'entry', person: ana }).state).toBe('none');
  });

  it('a Keep that could not lock an expired sign-in: what this tab holds may later hide the work, never remove it', async () => {
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

    // Day 31: this tab is shown again and saves what it held, from day 0: her work is hidden, and
    // all of it is kept (decision 011: a replay only ever hides).
    setClock(START + 31 * DAY);
    expect(await evaluate(START + 31 * DAY, { kind: 'entry' }).done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-expired' });
    expect(evaluate(START + 31 * DAY, { kind: 'entry', person: ana }).state).toBe('hidden');
    // The server letting her in shows it again.
    expect(secondTab.evaluate(START + 31 * DAY, { kind: 'let-in', person: ana }).state).toBe('none');
    expect(lockOf(ana)).toBeNull();
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });

  it('a Keep that could not lock an expired sign-in locks it, from when it was first found so, when "Try again" succeeds', async () => {
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
    expect(lockOf(ana)).toEqual({ since: START, reason: 'sign-in-expired' });
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

describe('whether a person\'s field content may show', () => {
  it('hides it from day 30 of a refusal saved on the phone, or held by the page because storage refused it', () => {
    giveWork(ana, START);
    giveWork(ben, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'company-inactive' });
    phone.quota = true;
    expect(evaluate(START, { kind: 'refused', person: ben, reason: 'company-inactive' }).state).toBe('unsaved');
    const day30 = START + LOCKED_LIMIT_MS;
    expect([contentHidden('t-a', 'ana', day30), contentHidden('t-a', 'ben', day30)]).toEqual([false, false]);
    // Day 31, storage still full: both are hidden, the held one too.
    expect([contentHidden('t-a', 'ana', day30 + 1), contentHidden('t-a', 'ben', day30 + 1)]).toEqual([true, true]);
    expect(lockOf(ben)).toBeNull();
    // A refusal that is not removed after 30 days hides nothing, saved or held.
    expect(evaluate(START, { kind: 'refused', person: otherAna, reason: 'second-step' }).state).toBe('unsaved');
    expect(contentHidden('t-b', 'ana', START + 400 * DAY)).toBe(false);
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
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'needs-invitation', fromServer: true }).done).toEqual(['t-a/ana']);
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
    const told: [string, boolean][] = [];
    const stop = onWorkRemoved((who, done) => told.push([who, done]));
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'member-disabled', fromServer: true }).done).toEqual([]);
    // The field shell that removal stopped is told, so it can be opened again.
    expect(told).toEqual([['t-a/ana', false]]);
    stop();
    const still = evaluate(later, { kind: 'entry', person: ana });
    expect(still.state).toBe('hidden');
    expect(await still.done).toEqual([]);
    phone.discardFails = false;
    expect(await evaluate(later + 1, { kind: 'entry' }).done).toEqual([]);
    expect(await evaluate(later + 1, { kind: 'refused', person: ana, reason: 'member-disabled', fromServer: true }).done).toEqual(['t-a/ana']);
  });

  it('never erases work whose lock a let-in elsewhere lifted while the removal was on its way', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'member-disabled' });
    const later = START + LOCKED_LIMIT_MS + 1;
    // Her client has stopped for the removal when another tab signs her in.
    phone.whileDiscarding = () => void secondTab.evaluate(later, { kind: 'let-in', person: ana });
    const told: [string, boolean][] = [];
    const stop = onWorkRemoved((who, done) => told.push([who, done]));
    expect(await evaluate(later, { kind: 'refused', person: ana, reason: 'member-disabled', fromServer: true }).done).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
    expect(lockOf(ana)).toBeNull();
    // Her field window, whose client stopped, is opened again for her.
    expect(told).toEqual([['t-a/ana', false]]);
    stop();
  });

  it('runs one removal at a time: two refusals at once remove a person once', async () => {
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    const later = START + LOCKED_LIMIT_MS + 1;
    const refused = () => evaluate(later, { kind: 'refused', person: ana, reason: 'member-disabled', fromServer: true }).done;
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
    expect(await evaluate(later, { kind: 'refused', person: ben, reason: 'account-disabled', fromServer: true }).done).toEqual(['t-a/ben']);
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
  it('removes work already past the limit before the saved sign-in goes, when the server says she is removed', async () => {
    saveRow(ana, 'estimator', START);
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    setClock(START + LOCKED_LIMIT_MS + 1);
    await signOutOnRefusal(authFor(ana), 't-a', config, 'member-disabled', true);
    expect(phone.log).toEqual(['removed t-a/ana', 'forgot t-a/ana']);
    expect(phone.work.has(keyOf(ana))).toBe(false);
    expect(phone.rows.has(keyOf(ana))).toBe(false);
  });

  it('removes nothing when the server only asks her to sign in again, and the sign-in still goes', async () => {
    saveRow(ana, 'estimator', START);
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    setClock(START + LOCKED_LIMIT_MS + 1);
    await signOutOnRefusal(authFor(ana), 't-a', config, 'sign-in-again', true);
    expect(phone.log).toEqual(['forgot t-a/ana']);
    expect(phone.work.has(keyOf(ana))).toBe(true);
  });

  it('"Try again" is no answer from the server: it locks and hides, and never removes', async () => {
    saveRow(ana, 'estimator', START + 29 * DAY);
    giveWork(ana, START);
    evaluate(START, { kind: 'refused', person: ana, reason: 'sign-in-again' });
    setClock(START + 29 * DAY);
    phone.quota = true;
    const failure = await signOutOnRefusal(authFor(ana), 't-a', config, 'member-disabled', true).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkNotSecuredError);

    // Day 31, storage answers, "Try again", with no signal: the lock is past 30 days, nothing goes.
    setClock(START + 31 * DAY);
    phone.quota = false;
    await (failure as InstanceType<typeof WorkNotSecuredError>).retry();
    expect(phone.discards).toEqual([]);
    expect(phone.work.has(keyOf(ana))).toBe(true);
    expect(evaluate(Date.now(), { kind: 'entry', person: ana }).state).toBe('hidden');
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
