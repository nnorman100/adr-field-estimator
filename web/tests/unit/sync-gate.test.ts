import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_CHECK_ENFORCE_WITHIN_MS,
  APP_CHECK_MONITOR_WAIT_MS,
  ASK_WITHIN_MS,
  judgeMe,
  meActor,
  OFFLINE_RETRY_MS,
  sessionValid,
  SyncGate,
  type GateDeps,
  type GateState,
  type MeAnswer,
} from '@/lib/field/sync-gate';

// The sync gate (S6-3, docs/plans/S6.md section 3) and the App Check step in it (TC-7): the field
// client's network goes on only after GET /api/me answered 200 with a future
// `fieldAccessExpiresAt`, and stays off, with the work kept, for every refusal.

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function me(expiresAt: number | null, extra: Record<string, unknown> = {}): MeAnswer {
  return {
    status: 200,
    body: {
      company: { id: 'company-a', name: 'Company A' },
      actor: { id: 'actor-a', displayName: null },
      role: 'estimator',
      capabilities: ['scope'],
      fieldAccessExpiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      ...extra,
    },
  };
}
const refused = (status: number, error: string): MeAnswer => ({ status, body: { error } });

describe('the actor id of an /api/me answer (S5b-1)', () => {
  it('is the person\'s id in the company, saved with the sign-in row, and nothing when the answer has none', () => {
    expect(meActor(me(NOW + DAY).body)).toEqual({ actorId: 'actor-a' });
    expect(meActor({ actor: { id: '' } })).toEqual({});
    expect(meActor({ actor: { id: 4 } })).toEqual({});
    expect(meActor({ company: { id: 'c' } })).toEqual({});
    expect(meActor(null)).toEqual({});
  });
});

describe('one /api/me answer, judged', () => {
  it('opens on a 200 whose access record runs past now', () => {
    expect(judgeMe(me(NOW + DAY), NOW)).toEqual({
      kind: 'open',
      facts: { companyId: 'company-a', companyName: 'Company A', role: 'estimator', capabilities: ['scope'], expiresAt: NOW + DAY },
    });
  });

  it.each([
    ['run out', me(NOW - 1)],
    ['ending now', me(NOW)],
    ['missing (a renewal that was skipped before any record)', me(null)],
    ['not a time', me(null, { fieldAccessExpiresAt: 'soon' })],
  ])('waits for renewal when the record is %s', (_name, answer) => {
    expect(judgeMe(answer, NOW)).toEqual({ kind: 'renewing' });
  });

  it.each([
    ['member_disabled', 403, 'member-disabled'],
    ['company_inactive', 403, 'company-inactive'],
    ['sign_in_again', 401, 'sign-in-again'],
    ['missing_token', 401, 'sign-in-again'],
    ['second_step_required', 403, 'second-step'],
    ['not_a_member', 403, 'needs-invitation'],
    ['account_disabled', 403, 'account-disabled'],
  ])('locks on %s', (code, status, reason) => {
    expect(judgeMe(refused(status, code), NOW)).toEqual({ kind: 'locked', reason });
  });

  it('tells a revoked sign-in (what disabling a member does) from one that is only too old', () => {
    expect(judgeMe(refused(401, 'sign_in_revoked'), NOW)).toEqual({ kind: 'locked', reason: 'session-revoked' });
    expect(judgeMe(refused(401, 'sign_in_again'), NOW)).toEqual({ kind: 'locked', reason: 'sign-in-again' });
  });

  it.each([
    ['no answer', { status: 0, body: null }],
    ['a server error', { status: 503, body: null }],
    ['a 200 of another shape', { status: 200, body: { company: { name: 'A' }, role: 'estimator' } }],
  ])('is offline on %s, never open', (_name, answer) => {
    expect(judgeMe(answer, NOW)).toEqual({ kind: 'offline' });
  });
});

describe('the offline me read (D7)', () => {
  it.each([
    ['estimator', 30],
    ['owner', 14],
    ['office', 14],
  ])('a %s sign-in stands in for %i days offline, and not after', (role, days) => {
    const authTime = NOW - days * DAY;
    expect(sessionValid({ role, authTime }, NOW)).toBe(true);
    expect(sessionValid({ role, authTime: authTime - 1000 }, NOW)).toBe(false);
  });

  it('does not stand in for a row with no role or sign-in time, or an unknown role', () => {
    expect(sessionValid({}, NOW)).toBe(false);
    expect(sessionValid({ role: 'estimator' }, NOW)).toBe(false);
    expect(sessionValid({ role: 'operator', authTime: NOW }, NOW)).toBe(true);
    expect(sessionValid({ role: 'admin', authTime: NOW }, NOW)).toBe(false);
  });
});

describe('the gate', () => {
  let answers: MeAnswer[];
  let calls: string[];
  let states: GateState[];

  function gate(extra: Partial<GateDeps> = {}): SyncGate {
    return new SyncGate({
      ask: vi.fn(async () => {
        calls.push('ask');
        return answers.length > 1 ? answers.shift()! : answers[0]!;
      }),
      enableNetwork: async () => void calls.push('enable'),
      disableNetwork: async () => void calls.push('disable'),
      onState: (state) => states.push(state),
      now: () => Date.now(),
      ...extra,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    calls = [];
    states = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the network once /api/me answers with a current record', async () => {
    answers = [me(NOW + 7 * DAY)];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'enable']);
    expect(g.current()).toMatchObject({ kind: 'open' });
  });

  it('waits while the renewal is skipped, asks again, and opens only when the expiry is in the future', async () => {
    // The record ran out while the phone was offline, and the first /api/me skipped its renewal.
    answers = [me(NOW - DAY), me(NOW - DAY), me(NOW + 7 * DAY)];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current()).toEqual({ kind: 'renewing' });
    expect(calls).not.toContain('enable');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls.filter((c) => c === 'ask')).toHaveLength(2);
    expect(calls).not.toContain('enable');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls).toEqual(['ask', 'ask', 'ask', 'enable']);
    expect(g.current()).toMatchObject({ kind: 'open' });
    g.stop();
  });

  it.each(['sign_in_again', 'second_step_required', 'member_disabled', 'company_inactive'])(
    'never opens the network on %s',
    async (code) => {
      answers = [refused(code === 'sign_in_again' ? 401 : 403, code)];
      const g = gate();
      g.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).not.toContain('enable');
      expect(g.current().kind).toBe('locked');
      g.stop();
    },
  );

  it('a disabled member stays locked, and is let through when the owner turns access back on', async () => {
    answers = [refused(403, 'member_disabled'), refused(403, 'member_disabled'), me(NOW + 7 * DAY)];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(g.current()).toEqual({ kind: 'locked', reason: 'member-disabled' });
    expect(calls).not.toContain('enable');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.at(-1)).toBe('enable');
    expect(g.current()).toMatchObject({ kind: 'open' });
    g.stop();
  });

  it('closes an open network on a later refusal or a skipped renewal, and when the signal goes', async () => {
    answers = [me(NOW + 7 * DAY), refused(403, 'member_disabled')];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    g.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'enable', 'ask', 'disable']);

    calls = [];
    answers = [me(NOW + 7 * DAY)];
    g.poke();
    await vi.advanceTimersByTimeAsync(0);
    await g.networkLost();
    expect(calls).toEqual(['ask', 'enable', 'disable']);
    expect(g.current()).toEqual({ kind: 'offline' });
    g.stop();
  });

  it('closes the network before the confirmed record runs out while the renewal keeps being skipped', async () => {
    answers = [me(NOW + 20_000)];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'enable']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toContain('disable');
    expect(g.current()).toEqual({ kind: 'renewing' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((c) => c === 'enable')).toHaveLength(1);
    g.stop();
  });

  it('does not keep the network on past the confirmed record when /api/me stops answering', async () => {
    answers = [me(NOW + 30_000), { status: 0, body: null }];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'enable']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toContain('disable');
    expect(g.current().kind).not.toBe('open');
    g.stop();
  });

  it('keeps a refusal locked when the next ask gets no answer', async () => {
    answers = [refused(403, 'member_disabled'), { status: 0, body: null }];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current()).toEqual({ kind: 'locked', reason: 'member-disabled' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.filter((c) => c === 'ask')).toHaveLength(2);
    expect(g.current()).toEqual({ kind: 'locked', reason: 'member-disabled' });
    expect(states.map((s) => s.kind)).not.toContain('offline');
    g.stop();
  });

  it('starts from a lock saved on the phone, keeps it with no answer, and lifts it when the server lets the person in', async () => {
    answers = [{ status: 0, body: null }, me(NOW + 7 * DAY)];
    const g = gate({ initial: { kind: 'locked', reason: 'company-inactive' } });
    expect(g.current()).toEqual({ kind: 'locked', reason: 'company-inactive' });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current()).toEqual({ kind: 'locked', reason: 'company-inactive' });
    expect(calls).toEqual(['ask']);
    g.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'ask', 'enable']);
    expect(g.current()).toMatchObject({ kind: 'open' });
    g.stop();
  });

  it('drops an answer for a sign-in that ended while it was awaited, and asks again', async () => {
    let who: string | null = 'ana';
    answers = [me(NOW + 7 * DAY), refused(401, 'missing_token')];
    const g = gate({
      session: () => who,
      ask: async () => {
        calls.push('ask');
        const answer = answers.shift()!;
        who = null;
        return answer;
      },
    });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'ask']);
    expect(states.map((s) => s.kind)).not.toContain('open');
    expect(g.current()).toEqual({ kind: 'locked', reason: 'sign-in-again' });
    g.stop();
  });

  it('does not report open, and leaves the network off, when the signal goes while the network is going on', async () => {
    answers = [me(NOW + 7 * DAY), { status: 0, body: null }];
    let finishEnable = () => undefined as void;
    const g = gate({
      enableNetwork: () =>
        new Promise<void>((done) => {
          calls.push('enable');
          finishEnable = done;
        }),
    });
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'enable']);
    await g.networkLost();
    finishEnable();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(0, 3)).toEqual(['ask', 'enable', 'disable']);
    expect(calls.at(-1)).not.toBe('enable');
    expect(states.map((s) => s.kind)).not.toContain('open');
    g.stop();
  });

  it('does not report open when the gate stops or the sign-in ends while the network is going on', async () => {
    for (const end of ['stop', 'sign-out'] as const) {
      calls = [];
      states = [];
      let who: string | null = 'ana';
      answers = [me(NOW + 7 * DAY), refused(401, 'missing_token')];
      let finishEnable = () => undefined as void;
      const g = gate({
        session: () => who,
        enableNetwork: () =>
          new Promise<void>((done) => {
            calls.push('enable');
            finishEnable = done;
          }),
      });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      if (end === 'stop') g.stop();
      else who = null;
      finishEnable();
      await vi.advanceTimersByTimeAsync(0);
      expect(states.map((s) => s.kind)).not.toContain('open');
      expect(calls).toContain('disable');
      g.stop();
    }
  });

  describe('the session limit, in every state', () => {
    let tokenComes = false;
    const reach: Record<string, { answers: () => MeAnswer[]; appCheck?: GateDeps['appCheck']; network: boolean }> = {
      starting: { answers: () => [], network: false },
      offline: { answers: () => [{ status: 0, body: null }], network: false },
      open: { answers: () => [me(NOW + 7 * DAY)], network: true },
      renewing: { answers: () => [me(NOW - DAY)], network: false },
      'checking-phone': {
        answers: () => [me(NOW + 7 * DAY)],
        appCheck: { mode: 'enforce', token: async () => (tokenComes ? 'fresh' : Promise.reject(new Error('no token'))) },
        network: false,
      },
      locked: { answers: () => [refused(403, 'member_disabled')], network: false },
    };

    it.each(Object.keys(reach))('from %s, a sign-in past the limit stops everything until it is valid again', async (from) => {
      const setup = reach[from]!;
      tokenComes = false;
      answers = setup.answers();
      let valid = true;
      const g = gate({ sessionValid: () => valid, appCheck: setup.appCheck ?? null });
      if (from !== 'starting') {
        g.start();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(g.current().kind).toBe(from);
      valid = false;
      g.checkSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.current()).toEqual({ kind: 'expired' });
      if (setup.network) expect(calls.at(-1)).toBe('disable');
      // Asking again changes nothing while the sign-in is too old, whatever the server says.
      answers = [me(NOW + 7 * DAY)];
      const enables = calls.filter((c) => c === 'enable').length;
      g.poke();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(g.current()).toEqual({ kind: 'expired' });
      expect(calls.filter((c) => c === 'enable')).toHaveLength(enables);
      // Signed in again: the next check opens.
      valid = true;
      tokenComes = true;
      g.poke();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.current()).toMatchObject({ kind: 'open' });
      g.stop();
    });

    it('does not open when the sign-in is past the limit at the first answer', async () => {
      answers = [me(NOW + 7 * DAY)];
      const g = gate({ sessionValid: () => false });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.current()).toEqual({ kind: 'expired' });
      expect(calls).toEqual(['ask']);
      g.stop();
    });
  });

  it('gives up on an /api/me that does not answer, and a later poke asks afresh', async () => {
    let first = true;
    const g = gate({
      ask: async () => {
        calls.push('ask');
        if (first) {
          first = false;
          return new Promise<MeAnswer>(() => undefined);
        }
        return me(NOW + 7 * DAY);
      },
    });
    g.start();
    await vi.advanceTimersByTimeAsync(ASK_WITHIN_MS);
    expect(g.current()).toEqual({ kind: 'offline' });
    g.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'ask', 'enable']);
    expect(g.current()).toMatchObject({ kind: 'open' });
    g.stop();
  });

  it('while the page is hidden, closes the network and asks nothing; shown again, asks before it opens', async () => {
    answers = [me(NOW + 7 * DAY)];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'enable']);
    await g.suspend();
    expect(calls).toEqual(['ask', 'enable', 'disable']);
    g.poke();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['ask', 'enable', 'disable']);
    g.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'enable', 'disable', 'ask', 'enable']);
    g.stop();
  });

  it('started while the page is hidden, asks nothing and keeps the network off until shown', async () => {
    answers = [me(NOW + 7 * DAY)];
    const g = gate({ startSuspended: true });
    g.start();
    g.poke();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
    g.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'enable']);
    g.stop();
  });

  it('works offline with no answer, and opens when the signal is back', async () => {
    answers = [{ status: 0, body: null }, me(NOW + 7 * DAY)];
    const g = gate();
    g.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.current()).toEqual({ kind: 'offline' });
    g.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ask', 'ask', 'enable']);
    g.stop();
  });

  // S6-3b: a stalled /api/me must never wedge the gate.
  describe('an /api/me that hangs', () => {
    const hangsOnce = () => {
      let first = true;
      return async () => {
        calls.push('ask');
        if (first) {
          first = false;
          return new Promise<MeAnswer>(() => undefined);
        }
        return me(NOW + 7 * DAY);
      };
    };

    it.each([
      ['a poke (a sign-in change, a tap)', (g: SyncGate) => g.poke()],
      ['the signal going and coming back', (g: SyncGate) => void g.networkLost().then(() => g.poke())],
      ['the page hidden and shown again', (g: SyncGate) => void g.suspend().then(() => g.resume())],
    ])('is called off by %s, which asks afresh at once', async (_name, wake) => {
      const g = gate({ ask: hangsOnce() });
      g.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toEqual(['ask']);
      wake(g);
      await vi.advanceTimersByTimeAsync(0);
      // Well before the 15 seconds the hanging call would have been given.
      expect(calls.slice(0, 2)).toEqual(['ask', 'ask']);
      expect(calls).toContain('enable');
      expect(g.current()).toMatchObject({ kind: 'open' });
      // The call that was given up on publishes nothing.
      expect(states.map((s) => s.kind)).not.toContain('offline');
      g.stop();
    });

    it('that rejects counts as no answer, and the next check still runs', async () => {
      let first = true;
      const g = gate({
        ask: async () => {
          calls.push('ask');
          if (first) {
            first = false;
            throw new Error('fetch failed');
          }
          return me(NOW + 7 * DAY);
        },
      });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.current()).toEqual({ kind: 'offline' });
      g.poke();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['ask', 'ask', 'enable']);
    });

    it('with no answer, asks again on the fixed retry after each give-up, and after any other answer on its own', async () => {
      const asks = () => calls.filter((c) => c === 'ask').length;
      const g = gate({
        ask: () => {
          calls.push('ask');
          return new Promise<MeAnswer>(() => undefined);
        },
      });
      g.start();
      // Asked at 0; given up on at 15 s; asked again 10 s after each give-up, every time.
      await vi.advanceTimersByTimeAsync(ASK_WITHIN_MS + OFFLINE_RETRY_MS);
      expect(asks()).toBe(2);
      for (const expected of [3, 4, 5]) {
        await vi.advanceTimersByTimeAsync(ASK_WITHIN_MS + OFFLINE_RETRY_MS - 1);
        expect(asks()).toBe(expected - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(asks()).toBe(expected);
      }
      g.stop();

      // No answer, then a renewal: each waits its own fixed time.
      calls = [];
      answers = [{ status: 0, body: null }, { status: 0, body: null }, me(NOW - DAY), { status: 0, body: null }, { status: 0, body: null }];
      const h = gate();
      h.start();
      await vi.advanceTimersByTimeAsync(2 * OFFLINE_RETRY_MS);
      expect(asks()).toBe(3);
      expect(h.current()).toEqual({ kind: 'renewing' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(asks()).toBe(4);
      await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_MS - 1);
      expect(asks()).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(asks()).toBe(5);
      h.stop();
    });
  });

  // O5 (S6-3b): the phone's refusal bookkeeping never depends on the sign-in still counting.
  describe('refusals and work that may no longer be sent', () => {
    it.each([
      [refused(401, 'sign_in_revoked'), 'session-revoked'],
      [refused(401, 'missing_token'), 'sign-in-again'],
      [refused(403, 'member_disabled'), 'member-disabled'],
    ] as const)('reports a refusal before it judges the sign-in\'s age (%j)', async (answer, reason) => {
      answers = [answer];
      const refusals: string[] = [];
      const g = gate({ sessionValid: () => false, onRefused: (why) => void refusals.push(why) });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(refusals).toEqual([reason]);
      expect(g.current()).toEqual({ kind: 'expired' });
      expect(calls).not.toContain('enable');
      g.stop();
    });

    it('reports a refusal while the sign-in counts too, but not one for a sign-in that changed', async () => {
      const refusals: string[] = [];
      answers = [refused(403, 'company_inactive')];
      const g = gate({ onRefused: (why) => void refusals.push(why) });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(refusals).toEqual(['company-inactive']);
      expect(g.current()).toEqual({ kind: 'locked', reason: 'company-inactive' });
      g.stop();

      refusals.length = 0;
      let who: string | null = 'ana';
      const h = gate({
        session: () => who,
        onRefused: (why) => void refusals.push(why),
        ask: async () => {
          who = who === 'ana' ? 'ben' : who;
          return refused(401, 'sign_in_revoked');
        },
      });
      h.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(refusals).toEqual(['session-revoked']);
      h.stop();
    });

    it('stops, with nothing asked, when the page is shown again after the work outlived the limit while hidden, the sign-in expired and no answer', async () => {
      // Reopened offline on day 29 past the role's limit; hidden; shown again on day 31.
      answers = [{ status: 0, body: null }];
      let sendable = true;
      const g = gate({ sessionValid: () => false, mayOpen: () => sendable });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.current()).toEqual({ kind: 'expired' });
      await g.suspend();
      sendable = false;
      g.resume();
      await vi.advanceTimersByTimeAsync(60_000);
      g.poke();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual(['ask']);
      expect(states).toEqual([{ kind: 'expired' }]);
    });

    it('stops at the next session check, every minute, whatever the state', async () => {
      answers = [refused(403, 'company_inactive')];
      let sendable = true;
      const g = gate({ initial: { kind: 'locked', reason: 'company-inactive' }, mayOpen: () => sendable });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.current()).toEqual({ kind: 'locked', reason: 'company-inactive' });
      sendable = false;
      g.checkSession();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual(['ask']);
    });

    it('stops after an answer that does not open the network, once the work outlived the limit', async () => {
      answers = [{ status: 0, body: null }];
      let sendable = true;
      const g = gate({ initial: { kind: 'locked', reason: 'company-inactive' }, mayOpen: () => sendable });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      sendable = false;
      await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_MS);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual(['ask', 'ask']);
    });

    it('does not open the network, and stops, when the work on the phone may no longer be sent', async () => {
      answers = [me(NOW + 7 * DAY)];
      let sendable = false;
      const g = gate({ mayOpen: () => sendable });
      g.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual(['ask']);
      expect(states).toEqual([]);
      g.poke();
      sendable = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual(['ask']);
    });
  });

  describe('App Check (TC-7)', () => {
    it('fetches a token before the network goes on', async () => {
      answers = [me(NOW + 7 * DAY)];
      const token = vi.fn(async () => {
        calls.push('token');
        return { token: 'fresh' };
      });
      const g = gate({ appCheck: { mode: 'monitor', token } });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['ask', 'token', 'enable']);
      g.stop();
    });

    it('in monitor mode, a failed token fetch does not hold the gate, and is counted', async () => {
      answers = [me(NOW + 7 * DAY)];
      const g = gate({ appCheck: { mode: 'monitor', token: async () => Promise.reject(new Error('expired')) } });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['ask', 'enable']);
      expect(g.current()).toMatchObject({ kind: 'open' });
      expect(g.appCheckMisses).toBe(1);
      g.stop();
    });

    it('in monitor mode, a token that will not come holds the gate 5 seconds at most', async () => {
      answers = [me(NOW + 7 * DAY)];
      const g = gate({ appCheck: { mode: 'monitor', token: () => new Promise(() => undefined) } });
      g.start();
      await vi.advanceTimersByTimeAsync(APP_CHECK_MONITOR_WAIT_MS - 1);
      expect(calls).toEqual(['ask']);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual(['ask', 'enable']);
      g.stop();
    });

    it('does not open when the token takes until the confirmed record is nearly out', async () => {
      answers = [me(NOW + 13_000)];
      const g = gate({ appCheck: { mode: 'monitor', token: () => new Promise(() => undefined) } });
      g.start();
      await vi.advanceTimersByTimeAsync(APP_CHECK_MONITOR_WAIT_MS);
      expect(calls).toEqual(['ask']);
      expect(g.current()).toEqual({ kind: 'renewing' });
      g.stop();
    });

    it('under enforcement, a token that will not come is given up on, and says "checking this phone"', async () => {
      answers = [me(NOW + 7 * DAY)];
      const g = gate({ appCheck: { mode: 'enforce', token: () => new Promise(() => undefined) } });
      g.start();
      await vi.advanceTimersByTimeAsync(APP_CHECK_ENFORCE_WITHIN_MS);
      expect(g.current()).toEqual({ kind: 'checking-phone' });
      expect(calls).toEqual(['ask']);
      g.stop();
    });

    it('under enforcement, waits with "checking this phone" and tries again; nothing is opened before', async () => {
      answers = [me(NOW + 7 * DAY)];
      let fail = true;
      const g = gate({ appCheck: { mode: 'enforce', token: async () => (fail ? Promise.reject(new Error('no token')) : 'fresh') } });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.current()).toEqual({ kind: 'checking-phone' });
      expect(calls).toEqual(['ask']);
      fail = false;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toEqual(['ask', 'ask', 'enable']);
      g.stop();
    });

    it('under enforcement, a token that will not come is asked for again 3 seconds after each give-up, and a poke asks at once', async () => {
      answers = [me(NOW + 7 * DAY)];
      const asks = () => calls.filter((c) => c === 'ask').length;
      const g = gate({ appCheck: { mode: 'enforce', token: () => new Promise(() => undefined) } });
      g.start();
      // Given up on at 10 s; asked again 3 s after each give-up, every time.
      await vi.advanceTimersByTimeAsync(APP_CHECK_ENFORCE_WITHIN_MS + 3_000);
      expect(asks()).toBe(2);
      for (const expected of [3, 4]) {
        await vi.advanceTimersByTimeAsync(APP_CHECK_ENFORCE_WITHIN_MS + 3_000 - 1);
        expect(asks()).toBe(expected - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(asks()).toBe(expected);
      }
      expect(g.current()).toEqual({ kind: 'checking-phone' });
      // Waiting for a token, a poke (the page shown again, the signal back) asks afresh at once.
      await vi.advanceTimersByTimeAsync(1_000);
      g.poke();
      await vi.advanceTimersByTimeAsync(0);
      expect(asks()).toBe(5);
      expect(calls).not.toContain('enable');
      g.stop();
    });

    it('under enforcement, a token that fails while the network is open closes it', async () => {
      answers = [me(NOW + 7 * DAY)];
      let fail = false;
      const g = gate({ appCheck: { mode: 'enforce', token: async () => (fail ? Promise.reject(new Error('no token')) : 'fresh') } });
      g.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['ask', 'enable']);
      fail = true;
      g.poke();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.current()).toEqual({ kind: 'checking-phone' });
      expect(calls).toEqual(['ask', 'enable', 'ask', 'disable']);
      g.stop();
    });
  });
});
