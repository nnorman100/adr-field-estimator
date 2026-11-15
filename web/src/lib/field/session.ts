// The signed-in person the job screens act as (S5a-6), started from the shell's saved sign-in
// (`ds-me`): the company's own Firebase app and Auth (firebase-client.ts), what the server says
// about this person (GET /api/me, which also renews their field database access record), and the
// field database client the screens write through. Online only in S5; S6 adds a persistent cache.
import { onAuthStateChanged, type User } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore';
import { z } from 'zod';
import { callApi, companyAuth } from '@/lib/firebase-client';
import { meOutcome } from '@/lib/sign-in/outcome';
import type { DsMe } from './ds-me';

export type FieldSession = {
  user: User;
  // null when the server has not named the field database (sign-in works without it); the scope
  // and photo screens then say they cannot open.
  db: Firestore | null;
  companyId: string;
  // The signed-in person's id in this company (GET /api/me), to tell whether they own a job's field
  // work (S5b-1); null when the answer did not name it.
  actorId: string | null;
  role: string;
  capabilities: string[];
};

export type SessionOutcome =
  | { kind: 'ready'; session: FieldSession }
  // No sign-in on this phone for the saved company, or the server wants a new one.
  | { kind: 'sign-in-again' }
  // The server could not be asked; the sign-in is kept.
  | { kind: 'unavailable' };

const me = z.object({
  company: z.object({ id: z.string() }),
  actor: z.object({ id: z.string() }).optional(),
  role: z.string(),
  capabilities: z.array(z.string()),
});

// The field database's client for one company app, made once per page: the SDK refuses a second
// set of settings for the same app.
const clients = new Map<string, Firestore>();

function fieldDatabase(saved: DsMe): Firestore | null {
  const databaseId = saved.config.firestoreDatabaseId;
  if (!databaseId) return null;
  const app = companyAuth({ config: saved.config, tenantId: saved.tenantId }).app;
  const found = clients.get(app.name);
  if (found) return found;
  const db = initializeFirestore(app, { localCache: memoryLocalCache() }, databaseId);
  if (saved.config.firestoreEmulatorUrl) {
    const url = new URL(saved.config.firestoreEmulatorUrl);
    connectFirestoreEmulator(db, url.hostname, Number(url.port));
  }
  clients.set(app.name, db);
  return db;
}

// Calls `lost` once the company's sign-in on this phone is no longer `uid`: signed out, or another
// person signed in, in this tab or another. Answers the function that stops watching.
export function watchSignIn(saved: DsMe, uid: string, lost: () => void): () => void {
  const auth = companyAuth({ config: saved.config, tenantId: saved.tenantId });
  return onAuthStateChanged(auth, (user) => {
    if (user?.uid !== uid) lost();
  });
}

export async function openSession(saved: DsMe): Promise<SessionOutcome> {
  const auth = companyAuth({ config: saved.config, tenantId: saved.tenantId });
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user || user.uid !== saved.uid) return { kind: 'sign-in-again' };
  const answer = await callApi(user, '/api/me');
  if (answer.status === 200) {
    const parsed = me.safeParse(answer.body);
    if (!parsed.success) return { kind: 'unavailable' };
    return {
      kind: 'ready',
      session: {
        user,
        db: fieldDatabase(saved),
        companyId: parsed.data.company.id,
        actorId: parsed.data.actor?.id ?? null,
        role: parsed.data.role,
        capabilities: parsed.data.capabilities,
      },
    };
  }
  const outcome = meOutcome(answer.status, answer.body);
  return outcome.kind === 'unavailable' ? { kind: 'unavailable' } : { kind: 'sign-in-again' };
}
