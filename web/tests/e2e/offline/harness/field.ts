// The second test page of the offline suite (S6-3): the app's own field client code behind a few
// plain functions on `window.f`, so a Playwright test drives exactly what the field shell runs:
// the person's Firestore client (src/lib/field-db.ts), the sync gate (field-sync.ts, sync-gate.ts),
// the unsent-work marks and the sign-out paths, against the emulators behind a lane. GET /api/me is
// the lane's stand-in, so a test decides what the server says (a skipped renewal, a refusal).
// Bundled by ../bundle.ts and served by the lane; never part of the app's build.
import { signInWithEmailAndPassword } from 'firebase/auth';
import { doc, enableNetwork, getDocFromCache, getDocFromServer, increment, setLogLevel, updateDoc, type DocumentData } from 'firebase/firestore';
import type { BrowserSignInConfig } from '../../../../src/lib/config';
import { companyAuth } from '../../../../src/lib/firebase-client';
import { fieldWrite, mirrorSignIn, setAppCheckSeam, startFieldClient, stopFieldClient, type CacheKind, type FieldClient } from '../../../../src/lib/field-db';
import { readLatestMe, saveMe, updateMe, type DsMe } from '../../../../src/lib/field/ds-me';
import { runFieldSync } from '../../../../src/lib/field/field-sync';
import { evaluate } from '../../../../src/lib/field/retention';
import { signOutDiscarding, signOutKeeping, signOutOnRefusal } from '../../../../src/lib/field/sign-out';
import type { GateState, SyncGate } from '../../../../src/lib/field/sync-gate';
import { readUnsent, unsentKey, type LockReason } from '../../../../src/lib/field/unsent';

setLogLevel('silent');

export type Person = { tenantId: string; uid: string; config: BrowserSignInConfig };
type Running = { client: FieldClient; gate: SyncGate | null; states: GateState[]; removed: boolean };

const running = new Map<string, Running>();
const ops = new Map<string, { state: 'pending' | 'acked' | 'rejected'; code?: string }>();
let counter = 0;
let tokenAnswer: 'expired' | 'slow' | 'fresh' = 'fresh';
let tokenCalls = 0;

const key = (person: Pick<Person, 'tenantId' | 'uid'>) => `${person.tenantId}/${person.uid}`;
const code = (error: unknown) => (error as { code?: string }).code ?? String(error);

function decode(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.__inc === 'number') return increment(record.__inc);
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

// The row the sign-in page saves, without the S6-3 facts.
function bareRow(person: Person): DsMe {
  return { ...person, companyName: 'Field Test', address: 'field-test', savedAt: Date.now() };
}

const DAY = 24 * 60 * 60 * 1000;

// The row the gate starts from: an estimator signed in `days` ago (just now by default).
function savedRow(person: Person, days = 0): DsMe {
  return { ...bareRow(person), role: 'estimator', authTime: Date.now() - days * DAY };
}

function get(person: Pick<Person, 'tenantId' | 'uid'>): Running {
  const found = running.get(key(person));
  if (!found) throw new Error('no field client started for that person');
  return found;
}

const withTimeout = <T,>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((done) => setTimeout(() => done(otherwise), ms))]);

const f = {
  // Signs in on the company's own app, as the sign-in page does.
  async signIn(person: Omit<Person, 'uid'>, email: string, password: string): Promise<string> {
    const auth = companyAuth(person);
    await auth.authStateReady();
    return (await signInWithEmailAndPassword(auth, email, password)).user.uid;
  },
  // The two sign-outs of src/lib/field/sign-out.ts: keep (every sign-out the person did not choose,
  // and Keep), and the person's own one that discards. `refusal`: the server's refusal that made
  // the app sign the person out.
  async signOutKeep(person: Person, refusal?: LockReason): Promise<void> {
    running.delete(key(person));
    const auth = companyAuth(person);
    await (refusal ? signOutOnRefusal(auth, person.tenantId, person.config, refusal, true) : signOutKeeping(auth, person.tenantId));
  },
  // What the field shell and the sign-in page do as they open (S6-3b): the phone's one retention
  // routine, which removes nothing (decision 010). Answers the person's state ('none', 'locked',
  // 'hidden') once it is over, and who was removed (nobody).
  async enter(person?: Person): Promise<{ state: string; removed: string[] }> {
    const { state, done } = evaluate(Date.now(), person ? { kind: 'entry', person } : { kind: 'entry' });
    return { state, removed: await done };
  },
  // The sign-in page when the server lets a person in: their own lock is lifted, however old
  // ('unlocked'), or stays when the phone cannot save that ('locked').
  async letIn(person: Person): Promise<'unlocked' | 'locked'> {
    const { state, done } = evaluate(Date.now(), { kind: 'let-in', person });
    await done;
    return state === 'none' ? 'unlocked' : 'locked';
  },
  async signOutDiscard(person: Person): Promise<string> {
    running.delete(key(person));
    return signOutDiscarding(companyAuth(person), person.tenantId, person.config);
  },

  // Starts the person's client as the field shell does, without the gate.
  async start(person: Person, cache: CacheKind, watchdogMs?: number): Promise<string> {
    const signedIn = await mirrorSignIn(person);
    const started = await startFieldClient(person, cache, watchdogMs === undefined ? {} : { watchdogMs });
    if (started.kind !== 'ready') return started.kind;
    running.set(key(person), { client: started.client, gate: null, states: [], removed: false });
    return `${started.client.cache}${started.fellBack ? ' (fell back)' : ''}${signedIn ? '' : ' (signed out)'}`;
  },
  // Runs the sync gate for it, as the field shell does, from a sign-in made `signedInDaysAgo`.
  sync(person: Person, signedInDaysAgo = 0): void {
    const entry = get(person);
    entry.gate = runFieldSync(entry.client, savedRow(person, signedInDaysAgo), (event) => {
      if ('state' in event) entry.states.push(event.state);
      if ('removed' in event) entry.removed = true;
    });
  },
  gate(person: Pick<Person, 'tenantId' | 'uid'>): string {
    if (get(person).removed) return 'removed';
    const states = get(person).states;
    return states.at(-1)?.kind === 'locked' ? `locked: ${(states.at(-1) as { reason: string }).reason}` : (states.at(-1)?.kind ?? 'starting');
  },
  poke(person: Pick<Person, 'tenantId' | 'uid'>): void {
    get(person).gate?.poke();
  },
  // The page hidden and shown again, as field-store.tsx tells the gate.
  async suspend(person: Pick<Person, 'tenantId' | 'uid'>): Promise<void> {
    await get(person).gate?.suspend();
  },
  resume(person: Pick<Person, 'tenantId' | 'uid'>): void {
    get(person).gate?.resume();
  },
  async stop(person: Person): Promise<void> {
    get(person).gate?.stop();
    running.delete(key(person));
    await stopFieldClient(person);
  },

  // A field edit through fieldWrite; dotted keys. `{__inc: n}` stands for an increment, which only
  // the tests use, to count how many times a write reached the server.
  write(person: Pick<Person, 'tenantId' | 'uid'>, path: string, data: Record<string, unknown>): string {
    const id = `op${(counter += 1)}`;
    ops.set(id, { state: 'pending' });
    fieldWrite(get(person).client, (db) => updateDoc(doc(db, path), decode(data) as DocumentData)).then(
      () => ops.set(id, { state: 'acked' }),
      (error: unknown) => ops.set(id, { state: 'rejected', code: code(error) }),
    );
    return id;
  },
  op: (id: string) => ops.get(id) ?? null,

  async readCache(person: Pick<Person, 'tenantId' | 'uid'>, path: string): Promise<{ data?: DocumentData | null; pending?: boolean; error?: string }> {
    try {
      const snapshot = await withTimeout(getDocFromCache(doc(get(person).client.db, path)), 8000, null);
      if (!snapshot) return { error: 'timeout' };
      return { data: snapshot.data() ?? null, pending: snapshot.metadata.hasPendingWrites };
    } catch (error) {
      return { error: code(error) };
    }
  },
  async readServer(person: Pick<Person, 'tenantId' | 'uid'>, path: string): Promise<{ data?: DocumentData | null; error?: string }> {
    try {
      const snapshot = await withTimeout(getDocFromServer(doc(get(person).client.db, path)), 8000, null);
      if (!snapshot) return { error: 'timeout' };
      return { data: snapshot.data() ?? null };
    } catch (error) {
      return { error: code(error) };
    }
  },

  unsent: (person: Pick<Person, 'tenantId' | 'uid'>) => readUnsent(person.tenantId, person.uid),

  // The saved sign-in rows (ds-me): the sign-in page's save, the field check's update, and which
  // (tenant/person) row the shell would start from.
  saveMe: (person: Person, facts: Pick<DsMe, 'role' | 'companyId' | 'capabilities' | 'authTime'> = {}) => saveMe({ ...bareRow(person), ...facts }),
  updateMe: (person: Person) => updateMe(bareRow(person)),
  // Sets this phone's unsent-work mark for a person, as a past session would have left it.
  setMark(person: Pick<Person, 'tenantId' | 'uid'>, mark: Record<string, unknown>): void {
    window.localStorage.setItem(unsentKey(person.tenantId, person.uid), JSON.stringify(mark));
  },
  async latestMe(): Promise<string | null> {
    const me = await readLatestMe();
    return me === null || me === 'unavailable' ? null : `${me.tenantId}/${me.uid}`;
  },
  async latestFacts(): Promise<Pick<DsMe, 'role' | 'companyId' | 'capabilities' | 'authTime'> | null> {
    const me = await readLatestMe();
    if (me === null || me === 'unavailable') return null;
    return { role: me.role, companyId: me.companyId, capabilities: me.capabilities, authTime: me.authTime };
  },

  // A fake App Check provider in field-db.ts's seam (TC-7): 'expired' always fails, 'slow' never
  // answers, 'fresh' answers; null empties the seam.
  // The provider's answer can change while a gate runs (the gate reads the seam when it starts).
  appCheck(mode: 'monitor' | 'enforce' | null, behaviour: 'expired' | 'slow' | 'fresh' = 'fresh'): void {
    tokenAnswer = behaviour;
    if (mode === null) return setAppCheckSeam(null);
    setAppCheckSeam({
      mode,
      token: () => {
        tokenCalls += 1;
        return tokenAnswer === 'fresh'
          ? Promise.resolve('fresh')
          : tokenAnswer === 'slow'
            ? new Promise(() => undefined)
            : Promise.reject(new Error('expired token'));
      },
    });
  },
  tokenCalls: () => tokenCalls,
  // Opens the network with no gate at all: what would happen without S6-3's gate.
  async openWithoutGate(person: Pick<Person, 'tenantId' | 'uid'>): Promise<void> {
    await enableNetwork(get(person).client.db);
  },

  // A hung IndexedDB for databases whose names start with `prefix` (as in page.ts).
  stallDatabases(prefix: string): void {
    const real = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
      return name.startsWith(prefix) ? ({} as IDBOpenDBRequest) : real.call(this, name, version);
    } as typeof real;
  },
  async databases(): Promise<string[]> {
    return ((await indexedDB.databases()) ?? []).map((database) => database.name ?? '').sort();
  },
};

export type FieldHarness = typeof f;
(window as unknown as { f: FieldHarness }).f = f;
