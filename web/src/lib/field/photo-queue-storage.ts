import { transact, withDatabase, type DbSpec } from './idb';
import type { PhotoField } from './schema';

export type PhotoOwner = Readonly<{ tenantId: string; uid: string }>;
export type PhotoTarget = Readonly<{ jobId: string; draftId: string; field: PhotoField }>;
export type PhotoUpload = PhotoOwner & PhotoTarget & {
  photoId: string;
  kind: 'photo' | 'original';
  sha256: string;
  photoSha256: string;
  contentType: string;
};
type ActiveStage = 'queued' | 'sent' | 'referenced';
export type PhotoQueueEntry = PhotoUpload & {
  stage: ActiveStage | 'done' | 'blocked';
  capturedAt: number;
  requested: boolean;
  attempts: number;
  retryAt: number;
  reason?: string;
  // Present only while the entry still has work to do, which is what the OPEN index holds.
  open?: 1;
};
type Payload = { entry: PhotoQueueEntry; data: ArrayBuffer };

const ENTRIES = 'entries';
const BYTES = 'bytes';
const OWNER = 'owner';
const OPEN = 'open';
const keyPath = ['tenantId', 'uid', 'jobId', 'photoId', 'kind'];
const SPEC: DbSpec = {
  name: 'ds-queue',
  version: 1,
  upgrade(db) {
    const entries = db.createObjectStore(ENTRIES, { keyPath });
    entries.createIndex(OWNER, ['tenantId', 'uid']);
    entries.createIndex(OPEN, ['tenantId', 'uid', OPEN]);
    db.createObjectStore(BYTES, { keyPath });
  },
};
const STORAGE_DEADLINE_MS = 5_000;

function keyOf(entry: PhotoUpload): string[] {
  return [entry.tenantId, entry.uid, entry.jobId, entry.photoId, entry.kind];
}
function ownerRange(owner: PhotoOwner) {
  return IDBKeyRange.only([owner.tenantId, owner.uid]);
}

function run<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => () => T,
): Promise<T> {
  let active: IDBTransaction | undefined;
  const deadline = AbortSignal.timeout(STORAGE_DEADLINE_MS);
  const operation = withDatabase(SPEC, (db) => {
    deadline.throwIfAborted();
    return transact(db, stores, mode, (transaction) => {
      active = transaction;
      try {
        return work(transaction);
      } catch (error) {
        transaction.abort();
        throw error;
      }
    }).finally(() => {
      active = undefined;
    });
  });
  return new Promise<T>((resolve, reject) => {
    const timedOut = () => {
      if (active) {
        try {
          active.abort();
        } catch {
          // The transaction is already finishing. Use its committed result.
          return;
        }
      }
      reject(deadline.reason);
    };
    deadline.addEventListener('abort', timedOut, { once: true });
    operation.then(resolve, reject).finally(() => deadline.removeEventListener('abort', timedOut));
  });
}

export function addCapture(payloads: readonly Payload[]): Promise<void> {
  return run([ENTRIES, BYTES], 'readwrite', (transaction) => {
    const entries = transaction.objectStore(ENTRIES);
    const bytes = transaction.objectStore(BYTES);
    for (const { entry, data } of payloads) {
      entries.add(entry);
      const { tenantId, uid, jobId, photoId, kind } = entry;
      bytes.add({ tenantId, uid, jobId, photoId, kind, data });
    }
    return () => undefined;
  });
}

export function readPhotoQueue(owner: PhotoOwner): Promise<PhotoQueueEntry[]> {
  return run(ENTRIES, 'readonly', (transaction) => {
    const request = transaction.objectStore(ENTRIES).index(OWNER).getAll(ownerRange(owner));
    return () => (request.result as PhotoQueueEntry[]).sort((a, b) => a.capturedAt - b.capturedAt);
  });
}

// The entries that still have work to do, with the photo row each waiting original needs to learn
// whether its photo has a receipt. Finished history is never read.
export function readPendingWork(owner: PhotoOwner): Promise<PhotoQueueEntry[]> {
  return run(ENTRIES, 'readonly', (transaction) => {
    const store = transaction.objectStore(ENTRIES);
    const open = store.index(OPEN).getAll(IDBKeyRange.only([owner.tenantId, owner.uid, 1]));
    const parents: IDBRequest<PhotoQueueEntry | undefined>[] = [];
    open.onsuccess = () => {
      for (const entry of open.result as PhotoQueueEntry[]) {
        if (entry.kind === 'original') parents.push(store.get(keyOf({ ...entry, kind: 'photo' })));
      }
    };
    return () => {
      const rows = new Map<string, PhotoQueueEntry>();
      for (const entry of [...(open.result as PhotoQueueEntry[]), ...parents.map((request) => request.result)]) {
        if (entry) rows.set(JSON.stringify(keyOf(entry)), entry);
      }
      return [...rows.values()].sort((a, b) => a.capturedAt - b.capturedAt);
    };
  });
}

export function readPayload(entry: PhotoUpload): Promise<ArrayBuffer | undefined> {
  return run(BYTES, 'readonly', (transaction) => {
    const request = transaction.objectStore(BYTES).get(keyOf(entry));
    return () => (request.result as { data: ArrayBuffer } | undefined)?.data;
  });
}

// Use the current row so a tap on Send originals is not overwritten by an in-flight upload.
// A row discarded or moved since the read is never recreated.
export function changePhoto(
  expected: PhotoQueueEntry,
  patch: Partial<Pick<PhotoQueueEntry, 'stage' | 'retryAt' | 'attempts' | 'reason'>>,
): Promise<PhotoQueueEntry | undefined> {
  const stores = patch.stage === 'done' ? [ENTRIES, BYTES] : ENTRIES;
  return run(stores, 'readwrite', (transaction) => {
    const entries = transaction.objectStore(ENTRIES);
    const key = keyOf(expected);
    const request = entries.get(key);
    let saved: PhotoQueueEntry | undefined;
    request.onsuccess = () => {
      const current = request.result as PhotoQueueEntry | undefined;
      if (!current || current.stage !== expected.stage || current.sha256 !== expected.sha256) return;
      saved = { ...current, ...patch };
      if (saved.stage === 'queued' || saved.stage === 'sent' || saved.stage === 'referenced') saved.open = 1;
      else delete saved.open;
      entries.put(saved);
      if (saved.stage === 'done') transaction.objectStore(BYTES).delete(key);
    };
    return () => saved;
  });
}

// The tap on one job's Photos screen releases that job's originals.
export function requestOriginals(owner: PhotoOwner, jobId: string): Promise<void> {
  return run(ENTRIES, 'readwrite', (transaction) => {
    const request = transaction.objectStore(ENTRIES).index(OWNER).openCursor(ownerRange(owner));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const entry = cursor.value as PhotoQueueEntry;
      if (entry.jobId === jobId && entry.kind === 'original' && entry.stage === 'queued' && !entry.requested) {
        cursor.update({ ...entry, requested: true });
      }
      cursor.continue();
    };
    return () => undefined;
  });
}
