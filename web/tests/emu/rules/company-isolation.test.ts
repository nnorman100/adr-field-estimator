// S3-17, the company-isolation gate: the Firestore rules half (the route and SQL half is
// tests/db/company-isolation.test.ts; both run in `npm run test:isolation`). Two companies in two
// sign-in tenants, each with an owner, an estimator and an office user holding live access records;
// every user of one company then tries every path, list and write of the other, and is refused
// (403). Controls prove the same calls work inside the user's own company, so a refusal is the
// company boundary and not a broken setup. 200 means the rules allowed the call, 403 refused it.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createTenant, projectId, signIn, signUp } from '../auth-emulator';
import { type Caller, commit, createDoc, deleteDoc, getDoc, listDocs, serverSet, updateDoc } from './firestore-rest';

type Person = { uid: string; caller: Caller; role: 'owner' | 'estimator' | 'office' };
type Company = { id: string; tenant: string; people: Record<'owner' | 'estimator' | 'office', Person> };

const run = randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;
const later = () => new Date(Date.now() + HOUR);

let a: Company;
let b: Company;

async function person(tenant: string, name: string, role: Person['role'], localId?: string): Promise<Person> {
  const email = `${name}-${run}@isolation.example.test`;
  const password = `synthetic-password-${name}`;
  const uid = localId ? await signUpWithUid(tenant, email, password, localId) : await signUp(tenant, email, password);
  return { uid, role, caller: { idToken: await signIn(tenant, email, password) } };
}

// An account with a chosen uid, made as the emulator's admin: the same uid in two tenants is two
// people, and the rules must treat them so.
async function signUpWithUid(tenant: string, email: string, password: string, localId: string): Promise<string> {
  const reply = await call(`/v1/projects/${projectId}/tenants/${tenant}/accounts`, { localId, email, password }, true);
  if (reply.status !== 200) throw new Error(`Auth emulator would not create an account with a chosen uid (${reply.status})`);
  return localId;
}

async function company(name: string): Promise<Company> {
  const tenant = await createTenant(`isolation-${name}-${run}`);
  const id = `isolation-${name}-${run}`;
  const people = {
    owner: await person(tenant, `owner-${name}`, 'owner'),
    estimator: await person(tenant, `estimator-${name}`, 'estimator'),
    office: await person(tenant, `office-${name}`, 'office'),
  };
  await serverSet(`companies/${id}`, { authTenantId: tenant });
  for (const who of Object.values(people)) await serverSet(`companies/${id}/access/${who.uid}`, { role: who.role, expiresAt: later() });
  // A draft the estimator owns in the field, with a room and a photo reference.
  await serverSet(`companies/${id}/drafts/d1`, { fieldOwnerUid: people.estimator.uid, state: 'editing', field: { notes: 'wet carpet' } });
  await serverSet(`companies/${id}/drafts/d1/rooms/kitchen`, { field: { name: 'Kitchen' } });
  await serverSet(`companies/${id}/drafts/d1/photos/p1`, { field: {} });
  return { id, tenant, people };
}

beforeAll(async () => {
  a = await company('a');
  b = await company('b');
});

const draft = (who: Company) => `companies/${who.id}/drafts/d1`;
const people = (who: Company) => Object.values(who.people);

describe('the field database rules, company against company', () => {
  it('lets each company’s own people read what their role reads, so the refusals below are the boundary', async () => {
    for (const who of [a, b]) {
      for (const p of people(who)) {
        // Owner and office read every draft of the company; the estimator reads the one they own.
        expect(await getDoc(p.caller, draft(who)), `${who.id} ${p.role}`).toBe(200);
        expect(await getDoc(p.caller, `${draft(who)}/rooms/kitchen`), `${who.id} ${p.role}`).toBe(200);
        expect(await getDoc(p.caller, `${draft(who)}/photos/p1`), `${who.id} ${p.role}`).toBe(200);
      }
      expect(await updateDoc(who.people.estimator.caller, draft(who), { field: { notes: 'dry wall' } })).toBe(200);
    }
  });

  it('refuses every user of the other company every read, list, write and delete', async () => {
    for (const [attacker, victim] of [[b, a], [a, b]] as const) {
      for (const p of people(attacker)) {
        const who = `${attacker.id} ${p.role}`;
        for (const path of [
          `companies/${victim.id}`,
          `companies/${victim.id}/access/${victim.people.owner.uid}`,
          `companies/${victim.id}/access/${p.uid}`,
          draft(victim),
          `${draft(victim)}/rooms/kitchen`,
          `${draft(victim)}/photos/p1`,
        ]) {
          expect(await getDoc(p.caller, path), `${who} reads ${path}`).toBe(403);
        }
        for (const path of [`companies/${victim.id}/drafts`, `${draft(victim)}/rooms`, `${draft(victim)}/photos`, `companies/${victim.id}/access`, 'companies']) {
          expect(await listDocs(p.caller, path), `${who} lists ${path}`).toBe(403);
        }
        expect(await updateDoc(p.caller, draft(victim), { field: { notes: 'taken' } }), who).toBe(403);
        expect(await updateDoc(p.caller, `${draft(victim)}/rooms/kitchen`, { field: { name: 'taken' } }), who).toBe(403);
        expect(await createDoc(p.caller, `${draft(victim)}/rooms/new`, { field: { name: 'planted' } }), who).toBe(403);
        expect(await createDoc(p.caller, `${draft(victim)}/photos/new`, { field: {} }), who).toBe(403);
        expect(await createDoc(p.caller, `companies/${victim.id}/access/${p.uid}`, { role: 'owner', expiresAt: later() }), who).toBe(403);
        expect(await createDoc(p.caller, `companies/${victim.id}/drafts/planted`, { fieldOwnerUid: p.uid, state: 'editing', field: {} }), who).toBe(403);
        expect(await deleteDoc(p.caller, draft(victim)), who).toBe(403);
        expect(await deleteDoc(p.caller, `${draft(victim)}/rooms/kitchen`), who).toBe(403);
        // A batch that mixes the caller's own company with the other's is refused as a whole.
        expect(
          await commit(p.caller, [
            { path: `${draft(attacker)}/rooms/mixed`, data: { field: { name: 'own' } }, create: true },
            { path: `${draft(victim)}/rooms/mixed`, data: { field: { name: 'other' } }, create: true },
          ]),
          who,
        ).toBe(403);
      }
    }
    // Nothing the attackers tried changed the other company's records.
    for (const who of [a, b]) {
      expect(await getDoc(who.people.owner.caller, `${draft(who)}/rooms/kitchen`)).toBe(200);
      expect(await getDoc(who.people.owner.caller, `${draft(who)}/rooms/new`)).toBe(404);
      expect(await getDoc(who.people.owner.caller, `${draft(who)}/rooms/mixed`)).toBe(404);
    }
  });

  it('refuses a sign-in with no tenant, and no sign-in, in both companies', async () => {
    const reply = await call('/v1/accounts:signUp', { email: `project-${run}@isolation.example.test`, password: 'synthetic-password', returnSecureToken: true });
    const projectLevel: Caller = { idToken: reply.body.idToken as string };
    for (const who of [a, b]) {
      for (const caller of [projectLevel, null]) {
        expect(await getDoc(caller, draft(who))).toBe(403);
        expect(await listDocs(caller, `companies/${who.id}/drafts`)).toBe(403);
        expect(await updateDoc(caller, draft(who), { field: { notes: 'x' } })).toBe(403);
      }
    }
  });

  it('refuses another company’s person whose uid, or whose access record, matches one in this company', async () => {
    // The same uid in two tenants is two people: a B account that has A's estimator's uid does not
    // inherit that uid's access record or the drafts it owns in A.
    const twin = await person(b.tenant, 'twin', 'estimator', a.people.estimator.uid);
    expect(twin.uid).toBe(a.people.estimator.uid);
    expect(await getDoc(twin.caller, draft(a))).toBe(403);
    expect(await updateDoc(twin.caller, draft(a), { field: { notes: 'taken' } })).toBe(403);
    // A record in A for a B person (as a faulty projection might write) still does not open A.
    await serverSet(`companies/${a.id}/access/${b.people.owner.uid}`, { role: 'owner', expiresAt: later() });
    await serverSet(`companies/${a.id}/drafts/b-owned`, { fieldOwnerUid: b.people.owner.uid, state: 'editing', field: {} });
    expect(await getDoc(b.people.owner.caller, `companies/${a.id}/drafts/b-owned`)).toBe(403);
    expect(await updateDoc(b.people.owner.caller, `companies/${a.id}/drafts/b-owned`, { field: { notes: 'x' } })).toBe(403);
    expect(await getDoc(b.people.owner.caller, draft(a))).toBe(403);
    // Control: the same person still reaches their own company.
    expect(await getDoc(b.people.owner.caller, draft(b))).toBe(200);
  });
});
