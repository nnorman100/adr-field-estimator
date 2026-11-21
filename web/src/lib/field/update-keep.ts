// What an app update carries across its reload (S6-6): the photos an old build could not send (same
// id, same bytes, same draft), the new job, the saves it has no answer for, and the values a refused
// save left on a form. Update now writes them here for the signed-in person's `owner` (tenant and
// person, as pending.openFor names it) and reloads only once the write has committed; the field app
// of that same owner reads them back, puts them where the screens look for them, and only then
// deletes the row. No other owner reads it, and discarding the owner's work clears the row and
// whatever was about to be written.
//
// Only a phone whose person said "Keep jobs on this phone" gets a row: with Online only, or no
// answer, nothing is ever written, and Update now waits until the work is sent or discarded.
// Photo bytes are kept as an ArrayBuffer and a type, not a Blob, which Safari's IndexedDB has not
// always kept faithfully.
import { keepAnswer } from './keep-consent';
import { transact, withDatabase, type DbSpec } from './idb';
import { pending, type KeptWork, type PendingPhoto } from './pending';
import { offlineCaptureAllowed, readFieldSurface } from './platform';
import { notePhoto } from './unsent';

const SPEC: DbSpec = {
  name: 'ds-update-keep',
  version: 1,
  upgrade: (db) => {
    db.createObjectStore('kept', { keyPath: 'owner' });
  },
};
const STORE = 'kept';
// A stalled IndexedDB never leaves the update screen waiting for it.
const WITHIN_MS = 5_000;
type StoredPhoto = Omit<PendingPhoto, 'bytes'> & { buffer: ArrayBuffer; type: string };
type Stored = { owner: string; work: Omit<KeptWork, 'photos'> & { photos: Record<string, StoredPhoto[]> } };

function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the update row did not answer in time')), WITHIN_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const tenantOf = (owner: string): string => owner.slice(0, owner.indexOf('/'));
const uidOf = (owner: string): string => owner.slice(owner.indexOf('/') + 1);

// The person said to keep jobs on this phone, and this phone may. No answer counts as "no".
function mayKeep(owner: string): boolean {
  return keepAnswer(tenantOf(owner)) === 'keep' && offlineCaptureAllowed(readFieldSurface());
}

export const KEEP_BLOCKED = 'Send or discard your unsent changes first. This phone keeps no jobs, so the update cannot carry them.';

// Why an update must wait for the work this window holds: it cannot be carried on this phone.
export function keepBlock(): string | null {
  const held = pending.kept();
  return held && !mayKeep(held.owner) ? KEEP_BLOCKED : null;
}

async function stored(owner: string, work: KeptWork): Promise<Stored> {
  const photos: Record<string, StoredPhoto[]> = {};
  for (const [jobId, list] of Object.entries(work.photos)) {
    photos[jobId] = await Promise.all(list.map(async ({ bytes, ...photo }) => ({ ...photo, buffer: await bytes.arrayBuffer(), type: bytes.type })));
  }
  return { owner, work: { ...work, photos } };
}

function unstored({ work }: Stored): KeptWork {
  const photos: Record<string, PendingPhoto[]> = {};
  for (const [jobId, list] of Object.entries(work.photos)) {
    photos[jobId] = list.map(({ buffer, type, ...photo }) => ({ ...photo, bytes: new Blob([buffer], { type }) }));
  }
  return { ...work, photos };
}

// Counts the discards of each owner, so a write that was under way when the work was discarded can
// tell and remove what it wrote.
const discards = new Map<string, number>();
// The owners whose kept row this page has put back (or found none of): until then a row is never
// written over, as it may hold work this page has not seen.
const restored = new Set<string>();
const restoring = new Map<string, Promise<boolean>>();

// True when there is nothing to carry or it is on the phone now, committed. False when it could not
// be written: the update then waits, and the window keeps the work in memory as it was.
export async function keepForUpdate(): Promise<boolean> {
  const held = pending.kept();
  if (!held) return true;
  const { owner } = held;
  const before = discards.get(owner) ?? 0;
  if (!mayKeep(owner) || !(await restoreKept(owner))) return false;
  try {
    const row = await stored(owner, held.work);
    await bounded(
      withDatabase(SPEC, async (db) => {
        await transact(db, STORE, 'readwrite', (transaction) => {
          transaction.objectStore(STORE).put(row);
          return () => undefined;
        });
      }),
    );
  } catch {
    return false;
  }
  if ((discards.get(owner) ?? 0) === before) return true;
  await forgetKept(owner).catch(() => undefined);
  return false;
}

// What was written for an update that did not go through is not needed.
export function forgetKept(owner: string): Promise<void> {
  return bounded(
    withDatabase(SPEC, (db) =>
      transact(db, STORE, 'readwrite', (transaction) => {
        transaction.objectStore(STORE).delete(owner);
        return () => undefined;
      }),
    ),
  );
}

// The owner's work was discarded: nothing of it may be restored or written from this page again.
export async function discardKept(owner: string): Promise<void> {
  discards.set(owner, (discards.get(owner) ?? 0) + 1);
  pending.forget(owner);
  await forgetKept(owner);
}

// Puts back what an update kept for this owner, then deletes the consumed row. True when nothing is
// left to put back; false when the row could not be read or put back yet, and a later call tries
// again.
export function restoreKept(owner: string): Promise<boolean> {
  if (restored.has(owner) || typeof indexedDB === 'undefined') return Promise.resolve(true);
  const running = restoring.get(owner) ?? putBack(owner).finally(() => restoring.delete(owner));
  restoring.set(owner, running);
  return running;
}

async function putBack(owner: string): Promise<boolean> {
  try {
    const mine = await bounded(
      withDatabase(SPEC, (db) =>
        transact(db, STORE, 'readonly', (transaction) => {
          const request = transaction.objectStore(STORE).get(owner);
          return () => request.result as Stored | undefined;
        }),
      ),
    );
    if (mine) {
      const work = unstored(mine);
      // The photos are unsent on this page again before the row goes: closing this window warns, as
      // it does for any photo whose receipt has not come.
      const noted = Object.values(work.photos).flat().every((photo) => notePhoto(tenantOf(owner), uidOf(owner), photo.id));
      if (!noted || !pending.restore(owner, work)) return false;
    }
    restored.add(owner);
    if (mine) await forgetKept(owner).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
