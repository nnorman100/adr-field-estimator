// What an app update carries across its reload (S6-6): the photos an old build could not send (same
// id, same bytes), the saves it has no answer for, and the values a refused save left on the form.
// Update now writes them here for the signed-in person's `owner` (tenant and person, as
// pending.openFor names it) and reloads only once the write has committed; the field app of that
// same owner reads them back, puts them where the screens look for them, and deletes the row. No
// other owner reads it, and the existing discard flow clears the exact owner's row.
// Photo bytes are kept as an ArrayBuffer and a type, not a Blob, which
// Safari's IndexedDB has not always kept faithfully.
import { transact, withDatabase, type DbSpec } from './idb';
import { pending, type KeptWork, type PendingPhoto } from './pending';

const SPEC: DbSpec = {
  name: 'ds-update-keep',
  version: 1,
  upgrade: (db) => {
    db.createObjectStore('kept', { keyPath: 'owner' });
  },
};
const STORE = 'kept';
type StoredPhoto = Omit<PendingPhoto, 'bytes'> & { buffer: ArrayBuffer; type: string };
type Stored = { owner: string; work: Omit<KeptWork, 'photos'> & { photos: Record<string, StoredPhoto[]> } };

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

// True when there is nothing to carry or it is on the phone now, committed. False when it could
// not be written: the update then waits, and the window keeps the work in memory as it was.
export async function keepForUpdate(): Promise<boolean> {
  const held = pending.kept();
  if (!held) return true;
  try {
    const row = await stored(held.owner, held.work);
    await withDatabase(SPEC, async (db) => {
      await transact(db, STORE, 'readwrite', (transaction) => {
        transaction.objectStore(STORE).put(row);
        return () => undefined;
      });
    });
    return true;
  } catch {
    return false;
  }
}

// The update did not go through: what was written for it is not needed.
export async function forgetKept(owner: string): Promise<void> {
  await withDatabase(SPEC, (db) =>
    transact(db, STORE, 'readwrite', (transaction) => {
      transaction.objectStore(STORE).delete(owner);
      return () => undefined;
    }),
  );
}

const restored = new Set<string>();

// Puts back what an update kept for this owner, once per page, then deletes the consumed row.
export async function restoreKept(owner: string): Promise<void> {
  if (typeof indexedDB === 'undefined' || restored.has(owner)) return;
  restored.add(owner);
  try {
    const mine = await withDatabase(SPEC, (db) => transact(db, STORE, 'readonly', (transaction) => {
      const request = transaction.objectStore(STORE).get(owner);
      return () => request.result as Stored | undefined;
    }));
    if (mine && pending.restore(owner, unstored(mine))) await forgetKept(owner);
  } catch {
    restored.delete(owner);
  }
}
