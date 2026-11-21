import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A small Web Locks manager: shared and exclusive requests granted in arrival order, and query().
type Req = { name: string; mode: 'shared' | 'exclusive'; run: () => Promise<unknown>; done: (value: unknown) => void; fail: (e: unknown) => void };
function fakeLocks() {
  const held: { name: string; mode: string }[] = [];
  const queue: Req[] = [];
  const grantable = (r: Req) => !held.some((h) => h.name === r.name && (h.mode === 'exclusive' || r.mode === 'exclusive')) && !queue.slice(0, queue.indexOf(r)).some((q) => q.name === r.name);
  const pump = () => {
    for (const r of [...queue]) {
      if (!grantable(r)) continue;
      queue.splice(queue.indexOf(r), 1);
      const entry = { name: r.name, mode: r.mode };
      held.push(entry);
      void Promise.resolve()
        .then(r.run)
        .then(r.done, r.fail)
        .finally(() => {
          held.splice(held.indexOf(entry), 1);
          pump();
        });
    }
  };
  return {
    request: (name: string, options: { mode?: 'shared' | 'exclusive' } | (() => Promise<unknown>), callback?: () => Promise<unknown>) =>
      new Promise((done, fail) => {
        queue.push({ name, mode: typeof options === 'function' ? 'exclusive' : (options.mode ?? 'exclusive'), run: callback ?? (options as () => Promise<unknown>), done, fail });
        pump();
      }),
    query: async () => ({ held: held.map((h) => ({ ...h })), pending: queue.map(({ name, mode }) => ({ name, mode })) }),
  };
}

// Two windows of one browser: each has its own module state and shares the lock manager.
async function windowOf(locks: ReturnType<typeof fakeLocks>) {
  vi.resetModules();
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { locks });
  return import('@/lib/update-activity');
}

const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('activating an update while another window starts work', () => {
  it('does not activate when the other window already holds a save', async () => {
    const locks = fakeLocks();
    const office = await windowOf(locks);
    const end = office.beginUpdateActivity('save');
    await end.admitted;
    const field = await windowOf(locks);
    const activate = vi.fn(async () => true);
    expect(await field.whileActivatingUpdate(activate)).toBe('peer-held');
    expect(activate).not.toHaveBeenCalled();
    end();
  });

  it('keeps work another window starts mid-activation from starting until the worker has switched', async () => {
    const locks = fakeLocks();
    const field = await windowOf(locks);
    const office = await windowOf(locks);
    const events: string[] = [];
    let switched!: () => void;
    const controllerChange = new Promise<void>((done) => (switched = done));

    const activation = field.whileActivatingUpdate(async () => {
      events.push('activating');
      await controllerChange;
      events.push('switched');
      return true;
    });
    await settle();

    const saved = office.whileUpdateHeld('save', async () => {
      events.push('save started');
    });
    await settle();
    expect(events).toEqual(['activating']);

    switched();
    expect(await activation).toBe(true);
    await saved;
    expect(events).toEqual(['activating', 'switched', 'save started']);
  });

  it('waits for a hold that was granted just before the check and then refuses', async () => {
    const locks = fakeLocks();
    const field = await windowOf(locks);
    const office = await windowOf(locks);
    const end = office.beginUpdateActivity('upload');
    const activate = vi.fn(async () => true);
    const answer = await field.whileActivatingUpdate(activate);
    expect(answer).toBe('peer-held');
    expect(activate).not.toHaveBeenCalled();
    end();
  });

  it('activates when no other window holds anything, and ignores its own holds', async () => {
    const locks = fakeLocks();
    const field = await windowOf(locks);
    const own = field.beginUpdateActivity('unsent');
    await own.admitted;
    expect(await field.whileActivatingUpdate(async () => 'done')).toBe('done');
    own();
  });

  it('activates without Web Locks', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const { whileActivatingUpdate, whileUpdateHeld } = await import('@/lib/update-activity');
    expect(await whileActivatingUpdate(async () => 'done')).toBe('done');
    expect(await whileUpdateHeld('save', async () => 'saved')).toBe('saved');
  });
});
