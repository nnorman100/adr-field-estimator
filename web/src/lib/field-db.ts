import { deleteApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  signOut,
  updateCurrentUser,
  type Auth,
} from 'firebase/auth';
import {
  clearIndexedDbPersistence,
  connectFirestoreEmulator,
  disableNetwork,
  doc,
  getDocFromCache,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentSingleTabManager,
  terminate,
  waitForPendingWrites,
  type Firestore,
} from 'firebase/firestore';
import { appCheckSettings, startAppCheck } from '@/lib/app-check-client';
import type { BrowserSignInConfig } from '@/lib/config';
import { companyAuth } from '@/lib/firebase-client';
import { forgetItemLists } from '@/lib/field/ds-prices';
import { meKey } from '@/lib/field/ds-me';
import { forgetKept } from '@/lib/field/update-keep';
import { forgetUnsent, keepPhotosHere, mayHaveUnsent, noteWrite, settled, writesNow } from '@/lib/field/unsent';
import { addingEntries, forgetJournal, journalInMemory, readJournal } from '@/lib/field/journal';
import type { AppCheckSeam } from '@/lib/field/sync-gate';
import { whileNoFieldWindow } from '@/lib/field/window-lock';

// The one browser Firestore client of the field database (S6-3; docs/plans/S6.md section 5).
//
// One cache per person, not per company. The S6-1 tests found that the SDK keeps queued writes per
// person but cached documents per app instance: a second person signed in on the same instance read
// the first person's cached draft, even one the rules refuse them (section 12, (c)). Emptying the
// cache at sign-out would also drop the first person's unsent writes (the queue is in the same
// database), which D7 forbids. So each (company tenant, person) gets a Firebase app instance of its
// own, and the SDK names its IndexedDB database after the app: one person's cache and queue are a
// database no other person's client opens. The company's sign-in stays on the company app
// (firebase-client.ts); this app's Auth holds an in-memory copy of that same user
// (updateCurrentUser, documented for any Auth instance of the same project), made at every start
// and dropped when the company app signs out, so nothing new is kept on the phone.
//
// The client starts with its network off (sync-gate.ts opens it) and the single-window cache
// manager (O3; window-lock.ts keeps a second window from starting one at all). Its first call is a
// cache read: the SDK does nothing until it is used (S6-1 (a)), and the read is also the start-up
// watchdog. A persistent start that does not answer in time (a stalled IndexedDB, the Safari
// reports of section 2) falls back to the memory cache on the same app (S6-1 (e)), with the "Not
// saved on this phone" banner, unless this person may have unsent work: the stalled cache still
// holds it, and edits made in memory would be overtaken by those older queued values when that
// queue is sent later. Then the screen says "Reopen the app" and takes no edits.
//
// Every field write goes through fieldWrite(), which marks unsent work before the write (unsent.ts).

export type FieldPerson = { tenantId: string; uid: string; config: BrowserSignInConfig };
export type CacheKind = 'persistent' | 'memory';
export type FieldClient = { db: Firestore; cache: CacheKind; person: FieldPerson };

export type FieldStart =
  | { kind: 'ready'; client: FieldClient; fellBack: boolean }
  // The persistent cache stalled and may hold unsent work: no client, no edits.
  | { kind: 'reopen' }
  // The server has not named the field database (sign-in works without it).
  | { kind: 'no-database' };

export const WATCHDOG_MS = 5_000;

export const fieldAppName = (tenantId: string, uid: string): string => `dryscope-${tenantId}-field-${uid}`;

const clients = new Map<string, FieldClient>();

// App Check's place in the sync gate (TC-7). Empty until App Check is set up (TC-5), so the gate
// does not wait for a token; the offline tests put a fake provider here.
let appCheck: AppCheckSeam | null = null;
export function setAppCheckSeam(seam: AppCheckSeam | null): void {
  appCheck = seam;
}
export function appCheckSeam(): AppCheckSeam | null {
  return appCheck;
}
const auths = new Map<string, Auth>();

// App Check (TC-5) starts on the person app as on the company app, before its Auth and Firestore
// are used, when the server has given both the app id and the site key; off otherwise.
function fieldApp(person: FieldPerson): FirebaseApp {
  const name = fieldAppName(person.tenantId, person.uid);
  const { apiKey, authDomain, projectId } = person.config;
  const appCheck = appCheckSettings(person.config);
  const app =
    getApps().find((existing) => existing.name === name) ??
    initializeApp({ apiKey, authDomain, projectId, ...(appCheck ? { appId: appCheck.appId } : {}) }, name);
  startAppCheck(app, person.config);
  return app;
}

// The person app's Auth: in memory only, set to the company's tenant. Made before Firestore, which
// takes its sign-in from it.
function fieldAuth(app: FirebaseApp, person: FieldPerson): Auth {
  let auth = auths.get(app.name);
  if (!auth) {
    try {
      auth = initializeAuth(app, { persistence: inMemoryPersistence });
    } catch {
      auth = getAuth(app);
    }
    auths.set(app.name, auth);
  }
  if (auth.tenantId !== person.tenantId) auth.tenantId = person.tenantId;
  if (person.config.authEmulatorUrl !== null && auth.emulatorConfig === null) {
    connectAuthEmulator(auth, person.config.authEmulatorUrl, { disableWarnings: true });
  }
  return auth;
}

// Copies the company app's sign-in to the person app when it is this person; signs the person app
// out otherwise. True when the person is signed in. Works offline: nothing here asks the network.
export async function mirrorSignIn(person: FieldPerson): Promise<boolean> {
  const company = companyAuth({ config: person.config, tenantId: person.tenantId });
  const auth = fieldAuth(fieldApp(person), person);
  await Promise.all([company.authStateReady(), auth.authStateReady()]);
  const user = company.currentUser;
  if (user && user.uid === person.uid) {
    const mirrored = auth.currentUser;
    if (mirrored?.uid !== user.uid || mirrored.metadata.lastSignInTime !== user.metadata.lastSignInTime) await updateCurrentUser(auth, user);
    return true;
  }
  if (auth.currentUser) await signOut(auth);
  return false;
}

// The person app's signed-in user, for the person's own /api calls.
export function fieldUser(person: FieldPerson) {
  return fieldAuth(fieldApp(person), person).currentUser;
}

function makeClient(app: FirebaseApp, person: FieldPerson, databaseId: string, cache: CacheKind): Firestore {
  const localCache =
    cache === 'persistent'
      ? persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) })
      : memoryLocalCache();
  const db = initializeFirestore(app, { localCache }, databaseId);
  if (person.config.firestoreEmulatorUrl) {
    const url = new URL(person.config.firestoreEmulatorUrl);
    connectFirestoreEmulator(db, url.hostname, Number(url.port));
  }
  // In the same tick, before anything can start: nothing goes out until the sync gate says so
  // (S6-1 (f): queued writes then wait, even with the network up).
  void disableNetwork(db).catch(() => undefined);
  return db;
}

// The cache the SDK started for this client. Firebase is pinned (package.json); a shape this does
// not know counts as memory.
function startedCache(db: Firestore): CacheKind {
  const client = (db as unknown as { _firestoreClient?: { _offlineComponents?: { kind?: unknown } } })._firestoreClient;
  return client?._offlineComponents?.kind === 'persistent' ? 'persistent' : 'memory';
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), ms))]);
}

// Starts this person's client, or hands back the one this page already started.
export async function startFieldClient(
  person: FieldPerson,
  wanted: CacheKind,
  { watchdogMs = WATCHDOG_MS }: { watchdogMs?: number } = {},
): Promise<FieldStart> {
  const databaseId = person.config.firestoreDatabaseId;
  if (!databaseId) return { kind: 'no-database' };
  const app = fieldApp(person);
  const found = clients.get(app.name);
  if (found) return { kind: 'ready', client: found, fellBack: wanted === 'persistent' && found.cache === 'memory' };
  keepPhotosHere(person.tenantId, person.uid);
  fieldAuth(app, person);
  const db = makeClient(app, person, databaseId, wanted);
  if (wanted === 'memory') {
    const client: FieldClient = { db, cache: 'memory', person };
    clients.set(app.name, client);
    return { kind: 'ready', client, fellBack: false };
  }
  // The first call, and the watchdog: a cache that answers at all (a miss is an answer) is alive.
  const answer = await within(
    getDocFromCache(doc(db, 'ds-start', 'probe')).then(
      () => 'answered' as const,
      () => 'answered' as const,
    ),
    watchdogMs,
  );
  if (answer === 'answered' && startedCache(db) === 'persistent') {
    const client: FieldClient = { db, cache: 'persistent', person };
    clients.set(app.name, client);
    return { kind: 'ready', client, fellBack: false };
  }
  if (mayHaveUnsent(person.tenantId, person.uid)) return { kind: 'reopen' };
  // terminate() never finishes on a stalled client, but calling it frees the app (S6-1 (e)).
  void terminate(db).catch(() => undefined);
  const memory: FieldClient = { db: makeClient(app, person, databaseId, 'memory'), cache: 'memory', person };
  clients.set(app.name, memory);
  return { kind: 'ready', client: memory, fellBack: true };
}

// Clears the unsent mark once every write made so far has been acknowledged and the recovery
// journal holds nothing of this person's (an entry waiting, refused or changed is work the server
// does not have; with a memory cache, the journal this page holds) and no entry is being added. Waits for as long as the network is off; harmless to
// call again.
export async function settle(client: FieldClient): Promise<void> {
  const { tenantId, uid } = client.person;
  const writes = writesNow(tenantId, uid);
  if (writes === null) return;
  await waitForPendingWrites(client.db);
  const memory = client.cache !== 'persistent';
  if (memory) journalInMemory({ tenantId, uid });
  if ((memory || typeof indexedDB !== 'undefined') && (addingEntries({ tenantId, uid }) || (await readJournal({ tenantId, uid })).length > 0)) return;
  settled(tenantId, uid, writes);
}

// Every field edit goes through here: the mark first, then the write (absolute values only, never
// a transform; S6-1 (b)). The returned promise settles when the server answers, which with no
// signal is later; the edit is already in the cache when this is called. When the mark cannot be
// saved the edit is not made, and the promise rejects with UnsentMarkNotSaved.
export class UnsentMarkNotSaved extends Error {
  constructor() {
    super('This phone could not record the change, so it was not made.');
    this.name = 'UnsentMarkNotSaved';
  }
}

export function fieldWrite<T>(client: FieldClient, write: (db: Firestore) => Promise<T>): Promise<T> {
  if (noteWrite(client.person.tenantId, client.person.uid, Date.now(), client.cache === 'memory') === null) {
    return Promise.reject(new UnsentMarkNotSaved());
  }
  const result = write(client.db);
  result.then(
    () => void settle(client).catch(() => undefined),
    () => undefined,
  );
  return result;
}

// Ends this page's client for the person, if it has one (sign-out, Discard).
export async function stopFieldClient(person: Pick<FieldPerson, 'tenantId' | 'uid'>): Promise<void> {
  const name = fieldAppName(person.tenantId, person.uid);
  const client = clients.get(name);
  clients.delete(name);
  if (client) await within(terminate(client.db), 3_000);
  const auth = auths.get(name);
  if (auth?.currentUser) await signOut(auth).catch(() => undefined);
}

export type DiscardResult = 'discarded' | 'elsewhere' | 'failed' | 'kept';

// Removes this person's cache, recovery journal and unsent work for this company from the phone: Discard at sign-out,
// or the 30-day limit for locked work (O5). Only this (tenant, person)'s database: another
// company's or another person's is a database of its own and stays. A field window open elsewhere
// holds the database, so it answers 'elsewhere' and removes nothing; `lockHeld` is for the field
// window itself, which holds that lock. `stillWanted` is asked once the client has stopped, right
// before anything is erased: when it says no, nothing is ('kept'; the client is stopped).
export async function discardFieldWork(
  person: FieldPerson,
  { lockHeld = false, stillWanted }: { lockHeld?: boolean; stillWanted?: () => boolean } = {},
): Promise<DiscardResult> {
  const work = async (): Promise<DiscardResult> => {
    await stopFieldClient(person);
    if (stillWanted && !stillWanted()) return 'kept';
    if (!(await forgetItemLists(person, stillWanted).then(() => true, () => false))) return 'failed';
    if (stillWanted && !stillWanted()) return 'kept';
    // The recovery journal first: kept beside an emptied cache, its entries would be sent again at the
    // next start. Removed while the cache stays (a failure below), the phone is as it was before S6-4.
    const forgotten = await within(forgetJournal(person).then(() => 'forgotten' as const, () => 'failed' as const), 5_000);
    if (forgotten !== 'forgotten') return 'failed';
    const databaseId = person.config.firestoreDatabaseId;
    if (databaseId) {
      const app = fieldApp(person);
      // A client made only to name the database: never used, so never started, as the SDK requires.
      const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) }) }, databaseId);
      const cleared = await within(
        clearIndexedDbPersistence(db).then(
          () => 'cleared' as const,
          () => 'failed' as const,
        ),
        5_000,
      );
      auths.delete(app.name);
      await deleteApp(app).catch(() => undefined);
      if (cleared !== 'cleared') return 'failed';
    }
    if (typeof indexedDB !== 'undefined') {
      const discarded = await within(forgetKept(meKey(person.tenantId, person.uid)).then(() => true, () => false), 5_000);
      if (!discarded) return 'failed';
    }
    forgetUnsent(person.tenantId, person.uid);
    return 'discarded';
  };
  return lockHeld ? work() : whileNoFieldWindow(work);
}
