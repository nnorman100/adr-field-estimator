// The test page for the offline spike (S6-1): the pinned Firebase web SDK behind a few plain
// functions on `window.h`, so a Playwright test can drive the same calls the field screens will
// make (a Firestore client per company tenant, with a cache, signed in through that tenant's Auth)
// and read back what the SDK says. It is bundled by tests/e2e/offline/bundle.ts and served by the
// lane (lane.ts) next to the real app; it is never part of the app's own build.
//
// Every function returns plain JSON, so page.evaluate can carry the answer back.
import { deleteApp, getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  FirestoreError,
  clearIndexedDbPersistence,
  connectFirestoreEmulator,
  deleteField,
  disableNetwork,
  doc,
  enableNetwork,
  getDocFromCache,
  getDocFromServer,
  increment,
  initializeFirestore,
  memoryLocalCache,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  setDoc,
  setLogLevel,
  terminate,
  updateDoc,
  waitForPendingWrites,
  type DocumentData,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import type { BrowserSignInConfig } from '../../../../src/lib/config';

setLogLevel('silent');

export type CacheKind = 'single' | 'multi' | 'memory';
// `networkOff` switches the SDK's network off in the same tick the client is made, as the sync
// gate will (S6-3), so nothing gets to start before it.
export type Boot = { config: BrowserSignInConfig; tenantId: string; cache: CacheKind; appName?: string; networkOff?: boolean };
export type OpState = { state: 'pending' | 'acked' | 'rejected'; code?: string };
export type SnapshotEvent = {
  exists?: boolean;
  data?: DocumentData | null;
  fromCache?: boolean;
  hasPendingWrites?: boolean;
  error?: string;
};

type Entry = { db: Firestore; auth: Auth; appName: string };
const entries = new Map<string, Entry>();
const ops = new Map<string, OpState>();
const listeners = new Map<string, { events: SnapshotEvent[]; stop: Unsubscribe }>();
let counter = 0;

const code = (error: unknown): string => (error instanceof FirestoreError ? error.code : ((error as { code?: string }).code ?? String(error)));

function entry(key: string): Entry {
  const found = entries.get(key);
  if (!found) throw new Error(`nothing opened as ${key}`);
  return found;
}

// A value the test sent as a marker becomes the SDK's own sentinel.
function decode(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.__inc === 'number') return increment(record.__inc);
    if (record.__delete === true) return deleteField();
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

function localCache(kind: CacheKind) {
  if (kind === 'memory') return memoryLocalCache();
  return persistentLocalCache({ tabManager: kind === 'multi' ? persistentMultipleTabManager() : persistentSingleTabManager(undefined) });
}

function track(promise: Promise<unknown>): string {
  const id = `op${(counter += 1)}`;
  ops.set(id, { state: 'pending' });
  promise.then(
    () => ops.set(id, { state: 'acked' }),
    (error: unknown) => ops.set(id, { state: 'rejected', code: code(error) }),
  );
  return id;
}

const withTimeout = <T,>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((done) => setTimeout(() => done(otherwise), ms))]);

const h = {
  userAgent: () => navigator.userAgent,
  logLevel: (level: 'debug' | 'silent') => setLogLevel(level),

  // Starts a Firestore client for one company tenant, as the field screens will: an app named for
  // the tenant (firebase-client.ts does the same for Auth), its Auth set to the tenant, and the
  // field database with the chosen cache. Returns at once; nothing here waits for the network.
  open(key: string, boot: Boot): { ok: true; ms: number } | { ok: false; error: string } {
    const started = performance.now();
    try {
      const { config } = boot;
      const appName = boot.appName ?? `dryscope-${boot.tenantId}`;
      const app = getApps().find((existing) => existing.name === appName) ?? initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId }, appName);
      const auth = getAuth(app);
      auth.tenantId = boot.tenantId;
      if (config.authEmulatorUrl && auth.emulatorConfig === null) connectAuthEmulator(auth, config.authEmulatorUrl, { disableWarnings: true });
      const db = initializeFirestore(app, { localCache: localCache(boot.cache) }, config.firestoreDatabaseId);
      if (config.firestoreEmulatorUrl) {
        const url = new URL(config.firestoreEmulatorUrl);
        connectFirestoreEmulator(db, url.hostname, Number(url.port));
      }
      if (boot.networkOff) void disableNetwork(db);
      entries.set(key, { db, auth, appName });
      return { ok: true, ms: performance.now() - started };
    } catch (error) {
      return { ok: false, error: code(error) };
    }
  },

  async signIn(key: string, email: string, password: string): Promise<string> {
    const { auth } = entry(key);
    await auth.authStateReady();
    return (await signInWithEmailAndPassword(auth, email, password)).user.uid;
  },
  async signOut(key: string): Promise<void> {
    await signOut(entry(key).auth);
  },
  // The person this Auth instance remembers (restored from the phone's own storage on start).
  async uid(key: string): Promise<string | null> {
    const { auth } = entry(key);
    await auth.authStateReady();
    return auth.currentUser?.uid ?? null;
  },

  // Writes, started and left running: the id says how each one ends. A write that is waiting
  // for the network stays `pending`.
  set(key: string, path: string, data: Record<string, unknown>, merge = true): string {
    const ref = doc(entry(key).db, path);
    return track(merge ? setDoc(ref, decode(data) as DocumentData, { merge: true }) : setDoc(ref, decode(data) as DocumentData));
  },
  // `data` keys may be dotted paths ("field.notes").
  update(key: string, path: string, data: Record<string, unknown>): string {
    return track(updateDoc(doc(entry(key).db, path), decode(data) as DocumentData));
  },
  op: (id: string): OpState | null => ops.get(id) ?? null,

  // A listener on one document, with its metadata changes, kept as a list of what it saw.
  listen(key: string, path: string): string {
    const id = `listen${(counter += 1)}`;
    const events: SnapshotEvent[] = [];
    const stop = onSnapshot(
      doc(entry(key).db, path),
      { includeMetadataChanges: true },
      (snapshot) =>
        events.push({ exists: snapshot.exists(), data: snapshot.data() ?? null, fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites }),
      (error) => events.push({ error: code(error) }),
    );
    listeners.set(id, { events, stop });
    return id;
  },
  events: (id: string): SnapshotEvent[] => listeners.get(id)?.events ?? [],
  unlisten(id: string): void {
    listeners.get(id)?.stop();
  },

  // `ms` is how long to wait before giving up: a client whose storage has stalled never answers.
  async readCache(key: string, path: string, ms = 8000): Promise<SnapshotEvent> {
    try {
      const snapshot = await withTimeout(getDocFromCache(doc(entry(key).db, path)), ms, null);
      if (!snapshot) return { error: 'timeout' };
      return { exists: snapshot.exists(), data: snapshot.data() ?? null, fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites };
    } catch (error) {
      return { error: code(error) };
    }
  },
  async readServer(key: string, path: string, ms = 8000): Promise<SnapshotEvent> {
    try {
      const snapshot = await withTimeout(getDocFromServer(doc(entry(key).db, path)), ms, null);
      if (!snapshot) return { error: 'timeout' };
      return { exists: snapshot.exists(), data: snapshot.data() ?? null, fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites };
    } catch (error) {
      return { error: code(error) };
    }
  },

  // 'done' when every queued write has been acknowledged or refused; 'timeout' while one waits.
  async waitPending(key: string, ms = 8000): Promise<string> {
    try {
      return await withTimeout(waitForPendingWrites(entry(key).db).then(() => 'done'), ms, 'timeout');
    } catch (error) {
      return code(error);
    }
  },
  disableNetwork: (key: string) => disableNetwork(entry(key).db),
  enableNetwork: (key: string) => enableNetwork(entry(key).db),
  async terminate(key: string, ms = 5000): Promise<string> {
    const { db } = entry(key);
    entries.delete(key);
    try {
      return await withTimeout(terminate(db).then(() => 'terminated'), ms, 'timeout');
    } catch (error) {
      return code(error);
    }
  },
  // Empties this company's cache database: the client is ended first (the SDK requires it), so the
  // key must be opened again afterwards.
  async clearPersistence(key: string, ms = 5000): Promise<string> {
    const { db } = entry(key);
    entries.delete(key);
    try {
      return await withTimeout(terminate(db).then(() => clearIndexedDbPersistence(db)).then(() => 'cleared'), ms, 'timeout');
    } catch (error) {
      return code(error);
    }
  },
  async deleteApp(key: string): Promise<void> {
    const { appName } = entry(key);
    entries.delete(key);
    const app = getApps().find((existing) => existing.name === appName);
    if (app) await deleteApp(app);
  },

  // What a hung IndexedDB looks like to the SDK: the request is made and never answers. Only the
  // databases whose names start with `prefix` are held, so Auth's own storage keeps working.
  stallDatabases(prefix: string): void {
    // On the prototype, not on `indexedDB`: WebKit can drop a property set on its wrapper object.
    const real = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
      return name.startsWith(prefix) ? ({} as IDBOpenDBRequest) : real.call(this, name, version);
    } as typeof real;
  },

  // The names of this origin's IndexedDB databases, to see which company's cache is which.
  async databases(): Promise<string[]> {
    return ((await indexedDB.databases()) ?? []).map((database) => database.name ?? '').sort();
  },
};

export type Harness = typeof h;
(window as unknown as { h: Harness }).h = h;
