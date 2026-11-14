// A company, its people and one `editing` draft, seeded for an offline test (S6-1): the Auth
// emulator holds the company's sign-in tenant and the people, and the Firestore emulator the
// records the server would have written (company header, access records, the draft), written
// here with the Admin SDK, which the rules do not bind. Every call makes a company of its own, so
// tests running in parallel never meet each other's data.
//
// readDoc reads a document back with the Admin SDK: what the server really holds, whatever a
// phone's cache says.
import { randomUUID } from 'node:crypto';
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { createTenant, createUser } from '../sign-in/emulator';
import { PASSWORD } from '../sign-in/seed';
import { E2E_PROJECT, FIELD_DATABASE, FIRESTORE_EMULATOR_HOST } from './emulators';

function adminApp(): App {
  // firebase-admin reads this itself and then writes to the emulator with no credentials.
  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;
  return getApps().find((app) => app.name === 'offline-tests') ?? initializeApp({ projectId: E2E_PROJECT }, 'offline-tests');
}

export function adminDb(): Firestore {
  return getFirestore(adminApp(), FIELD_DATABASE);
}

export type Person = { name: string; email: string; password: string; uid: string };
export type World = {
  companyId: string;
  tenantId: string;
  draftId: string;
  // The draft's field owner, and any other people seeded for the company.
  owner: Person;
  people: Record<string, Person>;
  draftPath: string;
};

const HOUR = 60 * 60 * 1000;

// `roles` sets a role for a named person (estimator by default). The first person owns the draft.
export async function seedCompany(
  options: { people?: string[]; roles?: Record<string, 'owner' | 'estimator' | 'office'> } = {},
): Promise<World> {
  const run = randomUUID().slice(0, 8);
  const tenantId = await createTenant(`offline-${run}`);
  const companyId = `company-${run}`;
  const draftId = `draft-${run}`;
  const names = options.people ?? ['owner'];
  const people: Record<string, Person> = {};
  for (const name of names) {
    const email = `${name}-${run}@example.com`;
    const uid = await createUser(tenantId, { email, password: PASSWORD, emailVerified: true });
    people[name] = { name, email, password: PASSWORD, uid };
  }
  const owner = people[names[0]!]!;
  const db = adminDb();
  await db.doc(`companies/${companyId}`).set({ authTenantId: tenantId });
  for (const person of Object.values(people)) {
    await grantAccess(companyId, person, options.roles?.[person.name] ?? 'estimator');
  }
  const draftPath = `companies/${companyId}/drafts/${draftId}`;
  await db.doc(draftPath).set({ fieldOwnerUid: owner.uid, state: 'editing', field: { airMovers: 0 } });
  return { companyId, tenantId, draftId, owner, people, draftPath };
}

async function grantAccess(companyId: string, person: Person, role: 'owner' | 'estimator' | 'office'): Promise<void> {
  await adminDb()
    .doc(`companies/${companyId}/access/${person.uid}`)
    .set({ role, expiresAt: Timestamp.fromMillis(Date.now() + 24 * HOUR) });
}

// Rewrites a person's access record to stop working at `expiresAt` (S6-3): the server's renewal, or
// a record that ran out while the phone was offline.
export async function setAccessExpiry(world: Pick<World, 'companyId'>, person: Person, expiresAt: Date, role: 'owner' | 'estimator' | 'office' = 'estimator'): Promise<void> {
  await adminDb()
    .doc(`companies/${world.companyId}/access/${person.uid}`)
    .set({ role, expiresAt: Timestamp.fromDate(expiresAt) });
}

export async function removeAccess(companyId: string, person: Person): Promise<void> {
  await adminDb().doc(`companies/${companyId}/access/${person.uid}`).delete();
}

// The server's copy of a document, or null when there is none.
export async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const snapshot = await adminDb().doc(path).get();
  return snapshot.exists ? (snapshot.data() as Record<string, unknown>) : null;
}

// The `field` map of the world's draft, as the server holds it.
export async function readDraft(world: Pick<World, 'draftPath'>): Promise<{ state: string; fieldOwnerUid: string; field: Record<string, unknown> }> {
  const data = await readDoc(world.draftPath);
  if (!data) throw new Error('the seeded draft is missing');
  return data as { state: string; fieldOwnerUid: string; field: Record<string, unknown> };
}

// What the server does when a job is finished: the draft stops being editable.
export async function fenceDraft(world: Pick<World, 'draftPath'>): Promise<void> {
  await adminDb().doc(world.draftPath).update({ state: 'submitted' });
}
