// Host-wide lock for `npm run test:emu`. The emulators use the fixed ports in firebase.json
// (auth 9399, firestore 8399), so two runs on one machine would collide on "port taken". Each
// run takes this lock before the Firebase CLI starts and holds it until the emulators stop;
// a second run waits its turn instead of failing. A run with its own ports (ports.ts) needs no
// turn: it takes one of these locks per port instead (`tryAcquireLock`), so runs only wait for
// the ports they share.
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DRYSCOPE_EMU_LOCK moves it (tests use a private path so they never wait on a real run's lock).
export const DEFAULT_LOCK_PATH = process.env.DRYSCOPE_EMU_LOCK || join(tmpdir(), 'dryscope-test-emu.lock');
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 500;
// A lock file that exists but has no pid yet is a holder in the middle of creating it.
const UNWRITTEN_GRACE_MS = 5_000;

export type LockOptions = {
  path?: string;
  timeoutMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A lock is stale when its holder is gone: a killed run (SIGKILL) cannot release it.
function isStale(path: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0) return !processAlive(pid);
    return Date.now() - statSync(path).mtimeMs > UNWRITTEN_GRACE_MS;
  } catch {
    return false; // gone already; the next attempt will take it
  }
}

function tryTake(path: string): boolean {
  try {
    const fd = openSync(path, 'wx'); // exclusive create: only one process wins
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

// Takes the lock at `path` if it is free (or its holder is gone) without waiting: a release
// function when this process now holds it, null when another live process does.
export function tryAcquireLock(path: string): (() => void) | null {
  for (;;) {
    if (tryTake(path)) break;
    if (!isStale(path)) return null;
    rmSync(path, { force: true });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      // Only remove our own lock.
      if (readFileSync(path, 'utf8') === String(process.pid)) rmSync(path, { force: true });
    } catch {
      // already gone
    }
  };
}

// Resolves with a release function once this process holds the lock.
export async function acquireEmulatorLock(options: LockOptions = {}): Promise<() => void> {
  const path = options.path ?? DEFAULT_LOCK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const log = options.log ?? ((message: string) => console.error(message));
  const started = Date.now();
  let announced = false;
  for (;;) {
    const release = tryAcquireLock(path);
    if (release) return release;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Waited ${Math.round(timeoutMs / 1000)}s for another test:emu run to finish (lock ${path})`,
      );
    }
    if (!announced) {
      log(
        `Another test:emu run is using the emulator ports; waiting for it to finish (lock ${path})`,
      );
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
