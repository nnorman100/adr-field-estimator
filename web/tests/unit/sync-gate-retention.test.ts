import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_WITHIN_MS, APP_CHECK_ENFORCE_WITHIN_MS, OFFLINE_RETRY_MS, SyncGate, type GateDeps, type GateState, type MeAnswer } from '@/lib/field/sync-gate';

// S6-3b: what the sync gate tells the phone's retention routine (every refusal, every time the
// saved sign-in is found past its limit, the server letting the person in), that it asks again when
// the phone could not save it, and that no sequence of stalled answers, lost signal, hidden pages
// and pokes leaves it unable to open.

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
// The gate asks again this long after a refusal the owner can lift, or one the phone could not save.
const LOCKED_RETRY_MS = 15_000;

const open = (): MeAnswer => ({
  status: 200,
  body: {
    company: { id: 'company-a', name: 'Company A' },
    actor: { id: 'actor-a', displayName: null },
    role: 'estimator',
    capabilities: ['scope'],
    fieldAccessExpiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
  },
});
const refused = (status: number, error: string): MeAnswer => ({ status, body: { error } });
const NO_ANSWER: MeAnswer = { status: 0, body: null };

let calls: string[];
let states: GateState[];
let answer: () => Promise<MeAnswer>;

function gate(extra: Partial<GateDeps> = {}): SyncGate {
  return new SyncGate({
    ask: () => {
      calls.push('ask');
      return answer();
    },
    enableNetwork: async () => void calls.push('enable'),
    disableNetwork: async () => void calls.push('disable'),
    onState: (state) => states.push(state),
    now: () => Date.now(),
    ...extra,
  });
}
const asks = () => calls.filter((call) => call === 'ask').length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  calls = [];
  states = [];
  answer = async () => NO_ANSWER;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('what the gate tells the retention routine', () => {
  it('says the saved sign-in is past its limit at an answer with no signal, with no refusal from any server', async () => {
    const told: string[] = [];
    const g = gate({ sessionValid: () => false, onExpired: () => void told.push('expired'), onRefused: (why) => void told.push(why) });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current()).toEqual({ kind: 'expired' });
    expect(told).toEqual(['expired']);
    g.stop();
  });

  it('says so when the limit passes while the shell is open, and again at every later check of it', async () => {
    answer = async () => open();
    let valid = true;
    const told: string[] = [];
    const g = gate({ sessionValid: () => valid, onExpired: () => void told.push('expired') });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current().kind).toBe('open');
    expect(told).toEqual([]);

    valid = false;
    g.checkSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current()).toEqual({ kind: 'expired' });
    expect(told).toEqual(['expired']);
    g.checkSession();
    g.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(told.length).toBeGreaterThanOrEqual(3);
    expect(g.current()).toEqual({ kind: 'expired' });
    g.stop();
  });

  it('tells a refusal first and the expired sign-in too, when both hold', async () => {
    answer = async () => refused(401, 'sign_in_revoked');
    const told: string[] = [];
    const g = gate({ sessionValid: () => false, onExpired: () => void told.push('expired'), onRefused: (why) => void told.push(why) });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(told).toEqual(['session-revoked', 'expired']);
    g.stop();
  });

  it('asks whether the work may be sent with "opening" only as the network is about to go on', async () => {
    answer = async () => refused(403, 'company_inactive');
    const asked: boolean[] = [];
    const g = gate({ mayOpen: (opening) => (asked.push(opening), true) });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    g.checkSession();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain(true);
    expect(calls).not.toContain('enable');

    answer = async () => open();
    g.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.filter(Boolean)).toHaveLength(1);
    // Asked before the network went on, and the answer decides it.
    expect(calls.at(-1)).toBe('enable');
    g.stop();

    calls = [];
    const h = gate({ mayOpen: (opening) => !opening });
    h.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['ask']);
  });

  it('tells its owner\'s stop, and not its own stopping for work that may no longer be sent', async () => {
    let sendable = true;
    const stopped = vi.fn();
    const g = gate({ mayOpen: () => sendable, onStopped: stopped });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    sendable = false;
    g.checkSession();
    g.poke();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['ask']);
    expect(stopped).not.toHaveBeenCalled();
    g.stop();
    expect(stopped).toHaveBeenCalledOnce();
  });
});

describe('a refusal the phone could not save', () => {
  it.each([
    ['sign_in_again', 401],
    ['second_step_required', 403],
    ['sign_in_revoked', 401],
  ])('is asked for again every 15 seconds until it is saved, though %s needs a new sign-in', async (error, status) => {
    answer = async () => refused(status, error);
    let room = false;
    const g = gate({ onRefused: () => room });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current().kind).toBe('locked');
    expect(asks()).toBe(1);
    await vi.advanceTimersByTimeAsync(LOCKED_RETRY_MS);
    await vi.advanceTimersByTimeAsync(LOCKED_RETRY_MS);
    expect(asks()).toBe(3);
    expect(calls).not.toContain('enable');

    // Saved now: this refusal waits for the person, as before.
    room = true;
    await vi.advanceTimersByTimeAsync(LOCKED_RETRY_MS);
    expect(asks()).toBe(4);
    await vi.advanceTimersByTimeAsync(10 * LOCKED_RETRY_MS);
    expect(asks()).toBe(4);
    g.stop();
  });

  it('is asked for again when it is the saved sign-in past its limit, with no signal', async () => {
    let room = false;
    const told: number[] = [];
    const g = gate({ sessionValid: () => false, onExpired: () => (told.push(Date.now() - NOW), room) });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current()).toEqual({ kind: 'expired' });
    await vi.advanceTimersByTimeAsync(2 * LOCKED_RETRY_MS);
    expect(told).toEqual([0, LOCKED_RETRY_MS, 2 * LOCKED_RETRY_MS]);
    room = true;
    await vi.advanceTimersByTimeAsync(LOCKED_RETRY_MS);
    await vi.advanceTimersByTimeAsync(10 * LOCKED_RETRY_MS);
    expect(told).toHaveLength(4);
    expect(calls).not.toContain('enable');
    g.stop();
  });

  it('is asked for again at the minute\'s check of an open shell', async () => {
    answer = async () => open();
    let valid = true;
    let tellings = 0;
    const g = gate({ sessionValid: () => valid, onExpired: () => ((tellings += 1), false) });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    valid = false;
    g.checkSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(tellings).toBe(1);
    await vi.advanceTimersByTimeAsync(LOCKED_RETRY_MS);
    expect(tellings).toBe(2);
    expect(g.current()).toEqual({ kind: 'expired' });
    g.stop();
  });
});

// (2) of S6-3b: a stalled request must never wedge the gate.
type Step =
  | { kind: 'server'; says: 'open' | 'hang' | 'none' | 'refuse' | 'renew' | 'reject' }
  | { kind: 'token'; says: 'fresh' | 'hang' | 'fail' }
  | { kind: 'wait'; ms: number }
  | { kind: 'poke' | 'hide' | 'show' | 'signal-lost' | 'minute' | 'session-over' | 'session-back' };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('server' as const), says: fc.constantFrom('open' as const, 'hang' as const, 'none' as const, 'refuse' as const, 'renew' as const, 'reject' as const) }),
  fc.record({ kind: fc.constant('token' as const), says: fc.constantFrom('fresh' as const, 'hang' as const, 'fail' as const) }),
  fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 40_000 }) }),
  fc.record({ kind: fc.constantFrom('poke' as const, 'hide' as const, 'show' as const, 'signal-lost' as const, 'minute' as const, 'session-over' as const, 'session-back' as const) }),
);

describe('any sequence of stalled answers, lost signal, hidden pages and pokes', () => {
  it.each(['monitor', 'enforce'] as const)('never sends while it should not, and opens at the next poke once the server answers (App Check %s)', async (mode) => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 40 }), async (steps) => {
        vi.setSystemTime(NOW);
        let server: Extract<Step, { kind: 'server' }>['says'] = 'none';
        let token: Extract<Step, { kind: 'token' }>['says'] = 'fresh';
        let valid = true;
        let networkOn = false;
        let state: GateState = { kind: 'starting' };
        const never = new Promise<never>(() => undefined);
        const g = new SyncGate({
          ask: () => {
            if (server === 'hang') return never;
            if (server === 'reject') return Promise.reject(new Error('no route'));
            if (server === 'open') return Promise.resolve(open());
            if (server === 'renew') return Promise.resolve({ ...open(), body: { ...(open().body as object), fieldAccessExpiresAt: null } });
            return Promise.resolve(server === 'refuse' ? refused(401, 'sign_in_again') : NO_ANSWER);
          },
          enableNetwork: async () => void (networkOn = true),
          disableNetwork: async () => void (networkOn = false),
          appCheck: { mode, token: () => (token === 'hang' ? never : token === 'fail' ? Promise.reject(new Error('no token')) : Promise.resolve('token')) },
          onState: (next) => void (state = next),
          now: () => Date.now(),
          sessionValid: () => valid,
        });
        g.start();
        for (const next of steps) {
          if (next.kind === 'server') server = next.says;
          else if (next.kind === 'token') token = next.says;
          else if (next.kind === 'wait') await vi.advanceTimersByTimeAsync(next.ms);
          else if (next.kind === 'poke') g.poke();
          else if (next.kind === 'hide') await g.suspend();
          else if (next.kind === 'show') g.resume();
          else if (next.kind === 'signal-lost') await g.networkLost();
          else if (next.kind === 'minute') g.checkSession();
          else valid = next.kind === 'session-back';
          await vi.advanceTimersByTimeAsync(0);
          // The network is on only while the gate says open.
          if (networkOn) expect(state.kind).toBe('open');
        }

        // The server answers, the token comes, the sign-in counts, and the page is shown: one poke
        // (resume makes it) calls off whatever the gate was waiting for and opens it at once,
        // whatever came before.
        server = 'open';
        token = 'fresh';
        valid = true;
        g.resume();
        await vi.advanceTimersByTimeAsync(1);
        expect(state.kind).toBe('open');
        expect(networkOn).toBe(true);
        g.stop();
      }),
      { numRuns: 300 },
    );
  });

  it('gives up on a request that never answers and asks again by itself, with no poke at all', async () => {
    // Either /api/me does not answer, or it does and the App Check token will not come.
    const stalled = fc.oneof(
      fc.record({ server: fc.constantFrom('hang' as const, 'none' as const, 'reject' as const), token: fc.constantFrom('fresh' as const, 'hang' as const, 'fail' as const) }),
      fc.record({ server: fc.constant('open' as const), token: fc.constantFrom('hang' as const, 'fail' as const) }),
    );
    await fc.assert(
      fc.asyncProperty(stalled, fc.integer({ min: 0, max: 120_000 }), async ({ server, token }, stalledFor) => {
        vi.setSystemTime(NOW);
        let answering = false;
        let state: GateState = { kind: 'starting' };
        const never = new Promise<never>(() => undefined);
        const g = new SyncGate({
          ask: () => (answering || server === 'open' ? Promise.resolve(open()) : server === 'hang' ? never : server === 'reject' ? Promise.reject(new Error('no route')) : Promise.resolve(NO_ANSWER)),
          enableNetwork: async () => undefined,
          disableNetwork: async () => undefined,
          appCheck: { mode: 'enforce', token: () => (answering || token === 'fresh' ? Promise.resolve('token') : token === 'hang' ? never : Promise.reject(new Error('no token'))) },
          onState: (next) => void (state = next),
          now: () => Date.now(),
        });
        g.start();
        await vi.advanceTimersByTimeAsync(stalledFor);
        expect(state.kind).not.toBe('open');
        // From here the server and the token answer. The longest the gate can still be inside a
        // wait it began before is one give-up, and its own retry follows.
        answering = true;
        await vi.advanceTimersByTimeAsync(ASK_WITHIN_MS + APP_CHECK_ENFORCE_WITHIN_MS + OFFLINE_RETRY_MS);
        expect(state.kind).toBe('open');
        g.stop();
      }),
      { numRuns: 200 },
    );
  });
});
