// The one way the app opens its own IndexedDB databases (S6-4; docs/plans/S6.md section 2, the
// Safari IndexedDB row): ds-me, ds-journal and the stores S6 adds after them. Firestore's cache is
// the SDK's own and is not opened here.
//
// - Every connection gets a version-change handler that closes it, so a window still holding an
//   older connection never blocks another window's upgrade (the old app's trap: an upgrade that
//   waited for a tab the person had forgotten about).
// - Safari has shipped "UnknownError: Connection to Indexed Database server lost" after the app was
//   in the background (WebKit bug 273827). The open, and the work done with it, are tried once more
//   on a fresh connection; a second loss is ReopenTheApp, which the screen shows as it is.
// - A connection lives for one piece of work and is closed after it, so no page holds one open
//   while it is hidden (web.dev, "Back/forward cache": close IndexedDB connections a hidden page
//   does not need).

export type DbSpec = {
  name: string;
  version: number;
  // Creates the stores; called only when the database is new or older than `version`.
  upgrade: (db: IDBDatabase, oldVersion: number) => void;
};

export const REOPEN_TEXT = 'Reopen the app.';

export class ReopenTheApp extends Error {
  constructor() {
    super(REOPEN_TEXT);
    this.name = 'ReopenTheApp';
  }
}

// Safari's lost connection to its IndexedDB process, from an open, a transaction or a request.
export function connectionLost(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /connection to indexed database server lost/i.test(message);
}

function openOnce(spec: DbSpec): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    try {
      const request = indexedDB.open(spec.name, spec.version);
      request.onupgradeneeded = (event) => spec.upgrade(request.result, event.oldVersion);
      request.onsuccess = () => {
        const db = request.result;
        // An open that was blocked already answered; the connection it gets later is not kept.
        if (blocked) return db.close();
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error(`${spec.name} could not be opened`));
      request.onblocked = () => {
        blocked = true;
        reject(new Error(`${spec.name} is blocked`));
      };
    } catch (error) {
      reject(error instanceof Error ? error : new Error(`${spec.name} could not be opened`));
    }
  });
}

// One connection; the caller closes it. A lost connection is tried once more, then ReopenTheApp.
export async function openDatabase(spec: DbSpec): Promise<IDBDatabase> {
  try {
    return await openOnce(spec);
  } catch (error) {
    if (!connectionLost(error)) throw error;
  }
  try {
    return await openOnce(spec);
  } catch (error) {
    throw connectionLost(error) ? new ReopenTheApp() : error;
  }
}

// Runs `work` on a fresh connection and closes it after. When the connection is lost during the
// work, it runs once more on a new one; a second loss is ReopenTheApp. `work` must be safe to run
// twice (a lost connection commits nothing).
export async function withDatabase<T>(spec: DbSpec, work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const db = await openDatabase(spec);
    try {
      return await work(db);
    } catch (error) {
      if (!connectionLost(error)) throw error;
      if (attempt === 2) throw new ReopenTheApp();
    } finally {
      db.close();
    }
  }
}

// One transaction, settled when it has committed (not when its requests answered: a page that
// navigates away first loses it) or has aborted. `change` queues the requests; its result is what
// the promise answers. A failed request aborts the transaction, and the abort carries that
// request's error (a lost connection included): the error event comes before the abort sets it.
export function transact<T>(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, change: (transaction: IDBTransaction) => () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const result = change(transaction);
    transaction.oncomplete = () => resolve(result());
    transaction.onabort = () => reject(transaction.error ?? new Error('the transaction was aborted'));
  });
}
