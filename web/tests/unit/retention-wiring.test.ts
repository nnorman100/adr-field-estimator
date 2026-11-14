import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import type { FieldClient, FieldPerson } from '@/lib/field-db';
import type { DsMe } from '@/lib/field/ds-me';
import type { FailedSignOut } from '@/lib/field/sign-out';

// S6-3b: the entry points that reach the phone's retention routine (src/lib/field/retention.ts)
// through the app's own code: the sync gate of an open field shell (field-sync.ts), and a screen's
// forced sign-out with its "Try again" (sign-out.ts). The examples are the review findings the
// routine was rebuilt for.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);
const config: BrowserSignInConfig = { apiKey: 'key', authDomain: 'example.test', projectId: 'demo-field', authEmulatorUrl: null, firestoreDatabaseId: 'field' };
const person: FieldPerson = { tenantId: 't-a', uid: 'ana', config };

const items = new Map<string, string>();
let full = false;
const storage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem(key: string, value: string) {
    if (full) throw new DOMException('full', 'QuotaExceededError');
    items.set(key, value);
  },
  removeItem: (key: string) => void items.delete(key),
  get length() {
    return items.size;
  },
  key: (index: number) => [...items.keys()][index] ?? null,
};

let server: { status: number; body: unknown } = { status: 0, body: null };
const callApi = vi.fn(async () => server);
const forgetMe = vi.fn(async () => null);
const signOutCompany = vi.fn(async () => undefined);
const enableNetwork = vi.fn(async () => undefined);
const discarded: string[] = [];
const signedIn = { uid: 'ana' };

vi.mock('@/lib/field/ds-me', async (original) => ({
  ...(await original<typeof import('@/lib/field/ds-me')>()),
  forgetMe,
  saveMe: vi.fn(async () => true),
  readMe: vi.fn(async () => null),
  readAllMe: vi.fn(async () => []),
  updateMe: vi.fn(async () => true),
}));
vi.mock('@/lib/firebase-client', () => ({ signOutCompany, callApi }));
vi.mock('@/lib/field-db', async () => {
  const { forgetUnsent } = await import('@/lib/field/unsent');
  return {
    stopFieldClient: vi.fn(async () => undefined),
    discardFieldWork: vi.fn(async (who: FieldPerson) => {
      discarded.push(`${who.tenantId}/${who.uid}`);
      forgetUnsent(who.tenantId, who.uid);
      return 'discarded';
    }),
    appCheckSeam: () => null,
    // One object: the gate drops an answer when the signed-in user changed while it was awaited.
    fieldUser: () => signedIn,
    settle: vi.fn(async () => undefined),
  };
});
vi.mock('firebase/firestore', () => ({ enableNetwork, disableNetwork: vi.fn(async () => undefined) }));
vi.mock('firebase/auth', () => ({ getIdTokenResult: vi.fn(async () => ({ authTime: new Date().toISOString() })) }));

const { evaluate } = await import('@/lib/field/retention');
const { runFieldSync } = await import('@/lib/field/field-sync');
const { signOutOnRefusal, signOutOrShow } = await import('@/lib/field/sign-out');
const { noteWrite, readUnsent, unsentKey } = await import('@/lib/field/unsent');

const letIn = () => ({
  status: 200,
  body: { company: { id: 'c', name: 'A' }, actor: { id: 'a', displayName: null }, role: 'estimator', capabilities: [], fieldAccessExpiresAt: new Date(Date.now() + 7 * DAY).toISOString() },
});
const savedRow = (signedInDaysAgo: number): DsMe => ({ ...person, companyName: 'A', address: 'a', savedAt: 1, role: 'estimator', authTime: Date.now() - signedInDaysAgo * DAY });
const lockedMark = (days: number, reason: string) => JSON.stringify({ writes: 1, unsentSince: NOW - days * DAY, lockedSince: NOW - days * DAY, lockedReason: reason });

// Waits for the sweeps the gate's own tellings started: they run one after another.
const swept = () => evaluate(Date.now(), { kind: 'entry' }).done;

type Run = { states: string[]; removed: boolean; stop: () => void };
function sync(signedInDaysAgo = 0): Run {
  const run: Run = { states: [], removed: false, stop: () => undefined };
  const gate = runFieldSync({ db: {}, cache: 'persistent', person } as unknown as FieldClient, savedRow(signedInDaysAgo), (event) => {
    if ('state' in event) run.states.push(event.state.kind);
    if ('removed' in event) run.removed = true;
  });
  run.stop = () => gate.stop();
  return run;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  items.clear();
  full = false;
  server = { status: 0, body: null };
  discarded.length = 0;
  for (const mock of [callApi, forgetMe, signOutCompany, enableNetwork]) mock.mockClear();
  vi.stubGlobal('window', { localStorage: storage });
  noteWrite('t-a', 'ana', NOW - DAY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the sync gate of an open field shell', () => {
  it('starts the 30-day clock for a sign-in past its role\'s limit with no signal and no saved lock', async () => {
    const run = sync(31);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.states.at(-1)).toBe('expired');
    expect(readUnsent('t-a', 'ana')).toMatchObject({ unsentSince: NOW - DAY, lockedSince: NOW, lockedReason: 'sign-in-expired' });

    // Reopened with no signal ten days on: the first time stands.
    run.stop();
    vi.setSystemTime(NOW + 10 * DAY);
    const again = sync(41);
    await vi.advanceTimersByTimeAsync(0);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: NOW, lockedReason: 'sign-in-expired' });
    expect(again.states).toEqual(['locked', 'expired']);
    expect(enableNetwork).not.toHaveBeenCalled();
    expect(forgetMe).not.toHaveBeenCalled();
    again.stop();

    // A new sign-in was saved since (yesterday's), and there is still no signal: the phone works
    // offline again, with nothing locked.
    const fresh = sync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.states).toEqual(['offline']);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ unsentSince: NOW - DAY, lockedSince: null });
    fresh.stop();
  });

  it('starts it when the limit passes while the shell stays open with no signal', async () => {
    const run = sync(29);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.states.at(-1)).toBe('offline');
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: null });
    // The page hidden for two days, then shown: field-store.tsx resumes the gate.
    vi.setSystemTime(NOW + 2 * DAY);
    const gate = runFieldSync({ db: {}, cache: 'persistent', person } as unknown as FieldClient, savedRow(31), () => undefined);
    gate.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: NOW + 2 * DAY, lockedReason: 'sign-in-expired' });
    gate.stop();
    run.stop();
  });

  it.each([
    [29, true],
    [31, false],
  ])('when the server lets the person in after %i days locked, sends: %s', async (days, sends) => {
    items.set(unsentKey('t-a', 'ana'), lockedMark(days, 'sign-in-again'));
    server = letIn();
    const run = sync();
    await vi.advanceTimersByTimeAsync(0);
    await swept();
    expect(enableNetwork).toHaveBeenCalledTimes(sends ? 1 : 0);
    expect(run.removed).toBe(!sends);
    expect(discarded).toEqual(sends ? [] : ['t-a/ana']);
    if (sends) expect(readUnsent('t-a', 'ana')).toMatchObject({ unsentSince: NOW - days * DAY, lockedSince: null });
    // Work that was removed is not asked about again.
    const asked = callApi.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    if (!sends) expect(callApi.mock.calls.length).toBe(asked);
    run.stop();
  });

  it('starts locked from a mark it cannot read, and starts its clock, so that work is not kept for ever', async () => {
    items.set(unsentKey('t-a', 'ana'), '{not json');
    const run = sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.states[0]).toBe('locked');
    expect(readUnsent('t-a', 'ana')).toMatchObject({ unsentSince: expect.any(Number), lockedSince: NOW, lockedReason: 'sign-in-again' });
    expect(enableNetwork).not.toHaveBeenCalled();
    run.stop();
  });

  it('stops, and tells the shell, when another entry point of the phone removes this person\'s work', async () => {
    items.set(unsentKey('t-a', 'ana'), lockedMark(29, 'company-inactive'));
    const run = sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.states.at(-1)).toBe('locked');
    // Two days pass with the page hidden; shown again, the shell's own entry point runs first.
    vi.setSystemTime(NOW + 2 * DAY);
    expect(await evaluate(Date.now(), { kind: 'entry' }).done).toEqual(['t-a/ana']);
    expect(run.removed).toBe(true);
    const asked = callApi.mock.calls.length;
    server = letIn();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(callApi.mock.calls.length).toBe(asked);
    expect(enableNetwork).not.toHaveBeenCalled();
  });

  it('hears nothing of a removal once its owner stopped it', async () => {
    items.set(unsentKey('t-a', 'ana'), lockedMark(29, 'company-inactive'));
    const run = sync();
    await vi.advanceTimersByTimeAsync(0);
    run.stop();
    vi.setSystemTime(NOW + 2 * DAY);
    await evaluate(Date.now(), { kind: 'entry' }).done;
    expect(run.removed).toBe(false);
  });

  it('keeps asking, every 15 seconds, while the phone cannot save a "sign in again", and saves it once it can', async () => {
    server = { status: 401, body: { error: 'sign_in_again' } };
    full = true;
    const run = sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.states.at(-1)).toBe('locked');
    expect(items.get(unsentKey('t-a', 'ana'))).not.toContain('sign-in-again');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callApi).toHaveBeenCalledTimes(3);
    full = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: NOW + 45_000, lockedReason: 'sign-in-again' });
    expect(forgetMe).not.toHaveBeenCalled();
    expect(enableNetwork).not.toHaveBeenCalled();
    run.stop();
  });
});

const signedInAs = (uid: string, at = 'Fri, 13 Nov 2026 09:00:00 GMT') => ({ uid, metadata: { lastSignInTime: at } });

describe('the server letting the person in, on a phone that cannot save it', () => {
  it('keeps the lock shown and the network off, asks again every 15 seconds, and opens once it is saved', async () => {
    items.set(unsentKey('t-a', 'ana'), lockedMark(5, 'sign-in-again'));
    server = letIn();
    full = true;
    const run = sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.states.at(-1)).toBe('locked');
    expect(callApi).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(run.states.at(-1)).toBe('locked');
    expect(enableNetwork).not.toHaveBeenCalled();
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: NOW - 5 * DAY });

    full = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run.states.at(-1)).toBe('open');
    expect(enableNetwork).toHaveBeenCalledOnce();
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: null });
    run.stop();
  });
});

describe('"Try again" after a sign-out that could not save the refusal', () => {
  const auth = { currentUser: signedInAs('ana') } as unknown as Auth;

  it('makes the same sign-out again: the refusal is saved, the sign-in ends, and what followed the sign-out follows', async () => {
    const shown: FailedSignOut[] = [];
    const after = vi.fn();
    full = true;
    await signOutOrShow(() => signOutOnRefusal(auth, 't-a', config, 'sign-in-again'), (failed) => shown.push(failed), after);
    expect(shown.map((failed) => failed.name)).toEqual(['not-secured']);
    expect(after).not.toHaveBeenCalled();
    expect(forgetMe).not.toHaveBeenCalled();

    // Still no room: the same screen again, nothing signed out.
    const first = shown[0] as Extract<FailedSignOut, { name: 'not-secured' }>;
    await first.retry();
    expect(shown.map((failed) => failed.name)).toEqual(['not-secured', 'not-secured']);
    expect(forgetMe).not.toHaveBeenCalled();
    expect(signOutCompany).not.toHaveBeenCalled();

    // Room again. The server would no longer refuse a plain reload (the owner's sign-in is 20
    // minutes old); the retry does not ask it, it ends the sign-in it was told to end.
    full = false;
    await (shown[1] as Extract<FailedSignOut, { name: 'not-secured' }>).retry();
    expect(shown).toHaveLength(2);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: NOW, lockedReason: 'sign-in-again' });
    expect(forgetMe).toHaveBeenCalledWith('t-a', 'ana', null);
    expect(signOutCompany).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
  });

  it('shows the screen\'s own "could not open" for any other failure, with the refusal already saved', async () => {
    const shown: FailedSignOut[] = [];
    signOutCompany.mockRejectedValueOnce(new Error('no network'));
    await signOutOrShow(() => signOutOnRefusal(auth, 't-a', config, 'account-disabled'), (failed) => shown.push(failed));
    expect(shown).toEqual([{ name: 'unavailable' }]);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: NOW, lockedReason: 'account-disabled' });
  });
});

describe('a forced sign-out when someone else signs in meanwhile (another tab)', () => {
  it('saves the refusal for the person refused and leaves the newer sign-in alone', async () => {
    const auth = { currentUser: signedInAs('ana') };
    const leaving = signOutOnRefusal(auth as unknown as Auth, 't-a', config, 'sign-in-again');
    auth.currentUser = signedInAs('ben');
    await leaving;
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: NOW, lockedReason: 'sign-in-again' });
    expect(forgetMe).not.toHaveBeenCalled();
    expect(signOutCompany).not.toHaveBeenCalled();
  });

  it('"Try again" does nothing once someone else has signed in: no refusal saved, nobody signed out', async () => {
    const auth = { currentUser: signedInAs('ana') };
    const shown: FailedSignOut[] = [];
    const after = vi.fn();
    full = true;
    await signOutOrShow(() => signOutOnRefusal(auth as unknown as Auth, 't-a', config, 'sign-in-again'), (failed) => shown.push(failed), after);
    expect(shown.map((failed) => failed.name)).toEqual(['not-secured']);

    auth.currentUser = signedInAs('ben');
    full = false;
    await (shown[0] as Extract<FailedSignOut, { name: 'not-secured' }>).retry();
    expect(shown).toHaveLength(1);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: null });
    expect(readUnsent('t-a', 'ben')).toMatchObject({ lockedSince: null });
    expect(forgetMe).not.toHaveBeenCalled();
    expect(signOutCompany).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
  });

  it('leaves the same person\'s newer sign-in alone, made while the sign-out was pending', async () => {
    const auth = { currentUser: signedInAs('ana') };
    const leaving = signOutOnRefusal(auth as unknown as Auth, 't-a', config, 'sign-in-again');
    auth.currentUser.metadata = { lastSignInTime: 'Sat, 14 Nov 2026 09:00:00 GMT' };
    await leaving;
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: NOW, lockedReason: 'sign-in-again' });
    expect(forgetMe).not.toHaveBeenCalled();
    expect(signOutCompany).not.toHaveBeenCalled();
  });

  it('"Try again" does not end the same person\'s newer sign-in', async () => {
    const auth = { currentUser: signedInAs('ana') };
    const shown: FailedSignOut[] = [];
    full = true;
    await signOutOrShow(() => signOutOnRefusal(auth as unknown as Auth, 't-a', config, 'sign-in-again'), (failed) => shown.push(failed));
    expect(shown.map((failed) => failed.name)).toEqual(['not-secured']);

    auth.currentUser = signedInAs('ana', 'Sat, 14 Nov 2026 09:00:00 GMT');
    full = false;
    await (shown[0] as Extract<FailedSignOut, { name: 'not-secured' }>).retry();
    // Her newer sign-in counts: the old refusal is not saved over it.
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: null });
    expect(forgetMe).not.toHaveBeenCalled();
    expect(signOutCompany).not.toHaveBeenCalled();
  });
});
