import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireEmulatorLock } from '../emu/lock';

describe('emulator host lock', () => {
  let dir: string;
  let path: string;
  const quiet = { log: () => {}, pollMs: 10 };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emu-lock-'));
    path = join(dir, 'lock');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('makes a second taker wait until the first releases', async () => {
    const releaseFirst = await acquireEmulatorLock({ path, ...quiet });
    let second = false;
    const waiting = acquireEmulatorLock({ path, ...quiet }).then((release) => {
      second = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second).toBe(false);
    releaseFirst();
    (await waiting)();
    expect(existsSync(path)).toBe(false);
  });

  it('times out with a clear message while another run holds the lock', async () => {
    const release = await acquireEmulatorLock({ path, ...quiet });
    await expect(acquireEmulatorLock({ path, timeoutMs: 50, ...quiet })).rejects.toThrow(
      /Waited .* another test:emu run/,
    );
    release();
  });

  it('takes over a lock whose holder is gone', async () => {
    writeFileSync(path, '2147483646'); // no such process
    const release = await acquireEmulatorLock({ path, timeoutMs: 50, ...quiet });
    release();
  });
});
