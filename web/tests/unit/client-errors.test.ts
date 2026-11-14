import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createReporter,
  installClientErrors,
  reportBoundaryError,
  type ClientEnv,
} from '@/lib/client-errors';

// The browser side of TC-2 (docs/plans/TC.md): hooks, batching, the caps, and what happens offline.
// A fake page stands in for `window`: a real EventTarget, a fetch spy, and settable online and
// visibility state.

type Fake = ClientEnv & {
  events: EventTarget;
  fetchSpy: Mock<(url: string, init: RequestInit) => Promise<{ ok: boolean }>>;
  set: { online: (on: boolean) => void; visibility: (state: 'visible' | 'hidden') => void };
  fire: (type: string, extra?: Record<string, unknown>) => void;
  bodies: () => { reports: Record<string, unknown>[] }[];
};

function fakePage(overrides: { fetch?: () => Promise<{ ok: boolean }> } = {}): Fake {
  const events = new EventTarget();
  const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<{ ok: boolean }>>(overrides.fetch ?? (async () => ({ ok: true })));
  const page = {
    events,
    fetchSpy,
    addEventListener: (type: string, listener: (event: Event) => void) => events.addEventListener(type, listener),
    removeEventListener: (type: string, listener: (event: Event) => void) => events.removeEventListener(type, listener),
    location: { pathname: '/sign-in/acme-restoration' },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0.0.0 Mobile Safari/537.36', onLine: true },
    document: {
      visibilityState: 'visible',
      addEventListener: (type: string, listener: (event: Event) => void) => events.addEventListener(type, listener),
      removeEventListener: (type: string, listener: (event: Event) => void) => events.removeEventListener(type, listener),
    },
    fetch: fetchSpy,
    set: {
      online: (on: boolean) => {
        page.navigator.onLine = on;
      },
      visibility: (state: 'visible' | 'hidden') => {
        page.document.visibilityState = state;
      },
    },
    fire: (type: string, extra: Record<string, unknown> = {}) => {
      events.dispatchEvent(Object.assign(new Event(type), extra));
    },
    bodies: () => fetchSpy.mock.calls.map((call) => JSON.parse(String((call[1] as { body: string }).body))),
  };
  return page as unknown as Fake;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const SETTLE = 2000;

describe('hooks', () => {
  it('sends a script error as one scrubbed report, with keepalive and no credentials', async () => {
    const page = fakePage();
    installClientErrors(page);
    page.fire('error', { error: new TypeError('bad value for jane@example.com') });
    await vi.advanceTimersByTimeAsync(SETTLE);

    expect(page.fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = page.fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/client-errors');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit' });
    const reports = page.bodies()[0]!.reports;
    expect(reports).toHaveLength(1);
    expect(Object.keys(reports[0]!).sort()).toEqual(['browser', 'message', 'name', 'route', 'stack']);
    expect(reports[0]).toMatchObject({ name: 'TypeError', route: '/sign-in/[address]', browser: 'chrome' });
    expect(JSON.stringify(reports)).not.toMatch(/example\.com|acme-restoration/);
  });

  it('reports an unhandled rejection', async () => {
    const page = fakePage();
    installClientErrors(page);
    page.fire('unhandledrejection', { reason: new RangeError('too far') });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.bodies()[0]!.reports[0]).toMatchObject({ name: 'RangeError', message: 'too far' });
  });

  it('reports what a React error boundary caught, even before anything was installed', async () => {
    const page = fakePage();
    reportBoundaryError(new Error('render failed'), page);
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.bodies()[0]!.reports[0]).toMatchObject({ name: 'Error', message: 'render failed' });
  });

  it('batches reports that arrive together into one request', async () => {
    const page = fakePage();
    installClientErrors(page);
    page.fire('error', { error: new Error('one') });
    page.fire('unhandledrejection', { reason: new Error('two') });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);
    expect(page.bodies()[0]!.reports).toHaveLength(2);
  });

  it('counts a repeat of the same error like any other report, up to the cap', async () => {
    const page = fakePage();
    installClientErrors(page);
    for (let i = 0; i < 5; i++) page.fire('error', { error: new Error('same') });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.bodies()[0]!.reports).toHaveLength(5);
    for (let i = 0; i < 10; i++) page.fire('error', { error: new Error('same') });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.bodies().flatMap((b) => b.reports)).toHaveLength(10);
  });

  it('never throws out of a hook, whatever the event holds', async () => {
    const page = fakePage();
    installClientErrors(page);
    expect(() => {
      page.fire('error', {});
      page.fire('error', { error: null, message: 'Script error.' });
      page.fire('unhandledrejection', { reason: undefined });
      page.fire('unhandledrejection', { reason: { get message(): string { throw new Error('hostile'); } } });
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(SETTLE);
  });

  it('stops listening when cleaned up', async () => {
    const page = fakePage();
    const stop = installClientErrors(page);
    stop();
    page.fire('error', { error: new Error('after') });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps its count across a second install on the same page (React strict mode)', async () => {
    const page = fakePage();
    installClientErrors(page)();
    installClientErrors(page);
    for (let i = 0; i < 4; i++) page.fire('error', { error: new Error(`e${i}`) });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.bodies().flatMap((b) => b.reports)).toHaveLength(4);
  });
});

describe('caps', () => {
  it('sends at most 10 reports in one page load', async () => {
    const page = fakePage();
    installClientErrors(page);
    for (let i = 0; i < 15; i++) page.fire('error', { error: new Error(`distinct ${i}`) });
    await vi.advanceTimersByTimeAsync(SETTLE);
    for (let i = 15; i < 20; i++) page.fire('error', { error: new Error(`later ${i}`) });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.bodies().flatMap((b) => b.reports)).toHaveLength(10);
  });

  it('keeps no more than 20 waiting in memory, and no request is over 8 KB', async () => {
    const send = vi.fn<(body: string) => Promise<boolean>>(async () => true);
    let online = false;
    const reporter = createReporter({
      send,
      isOnline: () => online,
      isVisible: () => true,
      where: () => ({ pathname: '/field', userAgent: '' }),
      maxPerLoad: 100,
    });
    for (let i = 0; i < 30; i++) {
      const error = new Error(`message ${i} ${'padding '.repeat(60)}`);
      error.stack = Array.from({ length: 12 }, (_, f) => `    at fn${f} (https://a.example/_next/static/chunks/${'long-name-'.repeat(8)}${f}.js:${i + 1}:${f + 1})`).join('\n');
      reporter.report(error);
    }
    expect(reporter.waiting()).toBe(20);
    online = true;
    await reporter.flush();
    const bodies = send.mock.calls.map((call) => call[0]);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(8192);
    expect(bodies.flatMap((body) => JSON.parse(body).reports)).toHaveLength(20);
    expect(reporter.waiting()).toBe(0);
  });
});

describe('offline and leaving', () => {
  it('holds reports while offline and sends them once on the online event', async () => {
    const page = fakePage();
    installClientErrors(page);
    page.set.online(false);
    page.fire('error', { error: new Error('first') });
    page.fire('unhandledrejection', { reason: new Error('second') });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.fetchSpy).not.toHaveBeenCalled();

    page.set.online(true);
    page.fire('online');
    await vi.advanceTimersByTimeAsync(SETTLE);
    page.fire('online');
    page.fire('visibilitychange');
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);
    expect(page.bodies()[0]!.reports).toHaveLength(2);
  });

  it('sends held reports when the page becomes visible again', async () => {
    const page = fakePage();
    installClientErrors(page);
    page.set.online(false);
    page.fire('error', { error: new Error('held') });
    page.set.online(true);
    page.set.visibility('visible');
    page.fire('visibilitychange');
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.bodies()[0]!.reports).toHaveLength(1);
  });

  it('keeps a report whose request could not reach the server, and sends it once on the next online event', async () => {
    let reachable = false;
    const page = fakePage({
      fetch: async () => {
        if (!reachable) throw new TypeError('Failed to fetch');
        return { ok: true };
      },
    });
    installClientErrors(page);
    page.fire('error', { error: new Error('lost') });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);

    reachable = true;
    page.fire('online');
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).toHaveBeenCalledTimes(2);
    page.fire('online');
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).toHaveBeenCalledTimes(2);
    expect(page.bodies()[1]!.reports).toHaveLength(1);
  });

  it.each([
    ['online, while the batch is on its way', 'visible', 'online'],
    ['the page coming back, while the hide-time batch is on its way', 'hidden', 'visibilitychange'],
  ] as const)('sends again after a failed request when %s', async (_name, start, again) => {
    const fails: ((reason: Error) => void)[] = [];
    let reachable = false;
    const page = fakePage({
      fetch: () => (reachable ? Promise.resolve({ ok: true }) : new Promise((_resolve, reject) => fails.push(reject))),
    });
    installClientErrors(page);
    page.fire('error', { error: new Error('in flight') });
    if (start === 'hidden') {
      page.set.visibility('hidden');
      page.fire('visibilitychange');
    }
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);

    reachable = true;
    page.set.visibility('visible');
    page.fire(again);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);

    fails[0]!(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.fetchSpy).toHaveBeenCalledTimes(2);
    expect(page.bodies()[1]!.reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not try again on a timer when the server cannot be reached, only on online or visible', async () => {
    const page = fakePage({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    installClientErrors(page);
    page.fire('error', { error: new Error('unreachable') });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);
    page.fire('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(page.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not send a report again after the server answered, even with an error status', async () => {
    const page = fakePage({ fetch: async () => ({ ok: false }) });
    installClientErrors(page);
    page.fire('error', { error: new Error('refused') });
    await vi.advanceTimersByTimeAsync(SETTLE);
    page.fire('online');
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends at once, without waiting, when the page is hidden or being closed', () => {
    const page = fakePage();
    installClientErrors(page);
    page.fire('error', { error: new Error('on the way out') });
    page.set.visibility('hidden');
    page.fire('visibilitychange');
    expect(page.fetchSpy).toHaveBeenCalledTimes(1);

    page.fire('error', { error: new Error('after hiding') });
    page.fire('pagehide');
    expect(page.fetchSpy).toHaveBeenCalledTimes(2);
    expect(page.fetchSpy.mock.calls[1]![1].keepalive).toBe(true);
  });

  it.each(['visibilitychange', 'pagehide'])(
    'keeps a report whose %s send could not reach the server, and sends it once when the page is visible again',
    async (leaving) => {
      let reachable = false;
      const page = fakePage({
        fetch: async () => {
          if (!reachable) throw new TypeError('Failed to fetch');
          return { ok: true };
        },
      });
      installClientErrors(page);
      page.fire('error', { error: new Error('cut off') });
      page.set.visibility('hidden');
      page.fire(leaving);
      await vi.advanceTimersByTimeAsync(0);
      expect(page.fetchSpy).toHaveBeenCalledTimes(1);

      reachable = true;
      page.set.visibility('visible');
      page.fire('visibilitychange');
      await vi.advanceTimersByTimeAsync(SETTLE);
      expect(page.fetchSpy).toHaveBeenCalledTimes(2);
      expect(page.bodies()[1]!.reports).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(page.fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it('drops what is still waiting offline when the page closes, and stores nothing', () => {
    const page = fakePage();
    installClientErrors(page);
    page.set.online(false);
    page.fire('error', { error: new Error('never sent') });
    page.fire('pagehide');
    expect(page.fetchSpy).not.toHaveBeenCalled();
  });
});
