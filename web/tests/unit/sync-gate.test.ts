import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_CHECK_MONITOR_WAIT_MS, judgeMe, offlineSignInValid, SyncGate, type GateDeps, type GateState, type MeAnswer } from '@/lib/field/sync-gate';

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
    expect(offlineSignInValid({ role, authTime }, NOW)).toBe(true);
    expect(offlineSignInValid({ role, authTime: authTime - 1000 }, NOW)).toBe(false);
  });

  it('does not stand in for a row with no role or sign-in time, or an unknown role', () => {
    expect(offlineSignInValid({}, NOW)).toBe(false);
    expect(offlineSignInValid({ role: 'estimator' }, NOW)).toBe(false);
    expect(offlineSignInValid({ role: 'operator', authTime: NOW }, NOW)).toBe(true);
    expect(offlineSignInValid({ role: 'admin', authTime: NOW }, NOW)).toBe(false);
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
  });
});
