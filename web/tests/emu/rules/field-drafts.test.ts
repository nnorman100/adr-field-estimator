// Firestore rules for the field database (web/firestore.rules), checked against the emulator
// with two sign-in tenants. The server's records (company header, access records, drafts) are
// written with the emulator's admin token, as the server SDK would; every other call carries a
// real Auth emulator ID token for one user. 200 means the rules allowed the call, 403 refused it.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createTenant, signIn, signUp } from '../auth-emulator';
import { type Caller, createDoc, deleteDoc, getDoc, listDocs, serverSet, updateDoc } from './firestore-rest';

type User = { uid: string; caller: Caller };

const run = randomUUID().slice(0, 8);
const A = `company-a-${run}`;
const B = `company-b-${run}`;
const HOUR = 60 * 60 * 1000;
const later = () => new Date(Date.now() + HOUR);
const earlier = () => new Date(Date.now() - HOUR);

let tenantA: string;
let tenantB: string;
const users: Record<string, User> = {};

async function user(name: string, tenantId: string | undefined): Promise<User> {
  const email = `${name}-${run}@field.example.test`;
  const password = `synthetic-password-${name}`;
  const uid = tenantId ? await signUp(tenantId, email, password) : await signUpProjectLevel(email, password);
  const idToken = tenantId
    ? await signIn(tenantId, email, password)
    : await signInProjectLevel(email, password);
  return { uid, caller: { idToken } };
}

// A user of no tenant (project-level sign-in) has no `firebase.tenant` in the token.
async function signUpProjectLevel(email: string, password: string): Promise<string> {
  const reply = await call('/v1/accounts:signUp', { email, password, returnSecureToken: true });
  return reply.body.localId as string;
}

async function signInProjectLevel(email: string, password: string): Promise<string> {
  const reply = await call('/v1/accounts:signInWithPassword', { email, password, returnSecureToken: true });
  return reply.body.idToken as string;
}

function u(name: string): User {
  const found = users[name];
  if (!found) throw new Error(`No test user ${name}`);
  return found;
}

const draft = (company: string, id: string) => `companies/${company}/drafts/${id}`;
const access = (company: string, uid: string) => `companies/${company}/access/${uid}`;

async function grant(company: string, who: User, role: string, expiresAt: Date): Promise<void> {
  await serverSet(access(company, who.uid), { role, expiresAt });
}

async function serverDraft(company: string, id: string, owner: User, state: string): Promise<void> {
  await serverSet(draft(company, id), { fieldOwnerUid: owner.uid, state, field: { notes: 'wet carpet' } });
  await serverSet(`${draft(company, id)}/rooms/kitchen`, { field: { name: 'Kitchen' } });
}

beforeAll(async () => {
  tenantA = await createTenant('company-a');
  tenantB = await createTenant('company-b');
  for (const name of ['ownerA', 'estimatorA', 'otherEstimatorA', 'officeA', 'expiredA', 'noAccessA']) {
    users[name] = await user(name, tenantA);
  }
  users.estimatorB = await user('estimatorB', tenantB);
  users.projectUser = await user('projectUser', undefined);

  await serverSet(`companies/${A}`, { authTenantId: tenantA });
  await serverSet(`companies/${B}`, { authTenantId: tenantB });
  await grant(A, u('ownerA'), 'owner', later());
  await grant(A, u('estimatorA'), 'estimator', later());
  await grant(A, u('otherEstimatorA'), 'estimator', later());
  await grant(A, u('officeA'), 'office', later());
  await grant(A, u('expiredA'), 'estimator', earlier());
  await grant(B, u('estimatorB'), 'estimator', later());
  // A project-level user holding an access record in A: only the tenant check stands in the way.
  await grant(A, u('projectUser'), 'estimator', later());

  await serverDraft(A, 'editing', u('estimatorA'), 'editing');
  await serverDraft(A, 'submitting', u('estimatorA'), 'submitting');
  await serverDraft(A, 'submitted', u('estimatorA'), 'submitted');
  await serverDraft(A, 'office-owned', u('officeA'), 'editing');
  await serverDraft(A, 'expired-owner', u('expiredA'), 'editing');
  await serverDraft(A, 'no-access-owner', u('noAccessA'), 'editing');
  await serverDraft(A, 'project-user', u('projectUser'), 'editing');
  await serverDraft(B, 'editing', u('estimatorB'), 'editing');
});

describe('field database rules', () => {
  it('lets the field owner read and edit the field data of an editing draft', async () => {
    const owner = u('estimatorA').caller;
    expect(await getDoc(owner, draft(A, 'editing'))).toBe(200);
    expect(await updateDoc(owner, draft(A, 'editing'), { field: { notes: 'wet carpet, dry wall' } })).toBe(
      200,
    );
    expect(await getDoc(owner, `${draft(A, 'editing')}/rooms/kitchen`)).toBe(200);
    expect(
      await updateDoc(owner, `${draft(A, 'editing')}/rooms/kitchen`, { field: { name: 'Kitchen 2' } }),
    ).toBe(200);
    expect(await createDoc(owner, `${draft(A, 'editing')}/rooms/hall`, { field: { name: 'Hall' } })).toBe(
      200,
    );
    // Field map v1 (S5a-1) opens only rooms and photos under a draft, nothing deeper.
    expect(
      await createDoc(owner, `${draft(A, 'editing')}/rooms/hall/readings/r1`, { field: { pct: 14 } }),
    ).toBe(403);
    // Control for company B: its own estimator reaches its own draft.
    expect(await getDoc(u('estimatorB').caller, draft(B, 'editing'))).toBe(200);
  });

  it('refuses a user of company B everything of company A', async () => {
    const b = u('estimatorB').caller;
    for (const path of [
      `companies/${A}`,
      access(A, u('estimatorA').uid),
      draft(A, 'editing'),
      `${draft(A, 'editing')}/rooms/kitchen`,
    ]) {
      expect(await getDoc(b, path), path).toBe(403);
    }
    expect(await listDocs(b, `companies/${A}/drafts`)).toBe(403);
    expect(await listDocs(b, `${draft(A, 'editing')}/rooms`)).toBe(403);
    expect(await updateDoc(b, draft(A, 'editing'), { field: { notes: 'x' } })).toBe(403);
    expect(await createDoc(b, `${draft(A, 'editing')}/rooms/b`, { field: { name: 'x' } })).toBe(403);
    expect(await createDoc(b, access(A, u('estimatorB').uid), { role: 'owner', expiresAt: later() })).toBe(
      403,
    );
  });

  it('refuses a token of another tenant even when that uid holds an access record in the company', async () => {
    // B's estimator owns a draft in A and holds an unexpired access record there; the token's
    // tenant is still B's, so A refuses it.
    await grant(A, u('estimatorB'), 'owner', later());
    await serverDraft(A, 'b-owned', u('estimatorB'), 'editing');
    const b = u('estimatorB').caller;
    expect(await getDoc(b, draft(A, 'b-owned'))).toBe(403);
    expect(await updateDoc(b, draft(A, 'b-owned'), { field: { notes: 'x' } })).toBe(403);
    expect(await listDocs(b, `companies/${A}/drafts`)).toBe(403);

    const projectUser = u('projectUser').caller;
    expect(await getDoc(projectUser, draft(A, 'project-user'))).toBe(403);
    expect(await updateDoc(projectUser, draft(A, 'project-user'), { field: { notes: 'x' } })).toBe(403);
  });

  it('refuses an expired or missing access record', async () => {
    for (const [name, id] of [
      ['expiredA', 'expired-owner'],
      ['noAccessA', 'no-access-owner'],
    ] as const) {
      const caller = u(name).caller;
      expect(await getDoc(caller, draft(A, id)), name).toBe(403);
      expect(await getDoc(caller, `${draft(A, id)}/rooms/kitchen`), name).toBe(403);
      expect(await updateDoc(caller, draft(A, id), { field: { notes: 'x' } }), name).toBe(403);
      expect(await createDoc(caller, `${draft(A, id)}/rooms/new`, { field: { name: 'x' } }), name).toBe(403);
    }
    // The same draft opens again once the server renews the access record.
    await grant(A, u('expiredA'), 'estimator', later());
    expect(await getDoc(u('expiredA').caller, draft(A, 'expired-owner'))).toBe(200);
    await grant(A, u('expiredA'), 'estimator', earlier());
    expect(await getDoc(u('expiredA').caller, draft(A, 'expired-owner'))).toBe(403);
  });

  it('refuses a client writing an access record, the company header or a server-owned field', async () => {
    const owner = u('estimatorA');
    const ownerA = u('ownerA');
    // Its own access record: neither extend nor replace it, nor make one for someone else.
    expect(await updateDoc(owner.caller, access(A, owner.uid), { expiresAt: later() })).toBe(403);
    expect(await updateDoc(owner.caller, access(A, owner.uid), { role: 'owner' })).toBe(403);
    expect(
      await createDoc(u('noAccessA').caller, access(A, u('noAccessA').uid), {
        role: 'estimator',
        expiresAt: later(),
      }),
    ).toBe(403);
    expect(
      await createDoc(ownerA.caller, access(A, u('noAccessA').uid), {
        role: 'estimator',
        expiresAt: later(),
      }),
    ).toBe(403);
    expect(await deleteDoc(ownerA.caller, access(A, u('officeA').uid))).toBe(403);
    expect(await updateDoc(ownerA.caller, `companies/${A}`, { authTenantId: tenantB })).toBe(403);

    // Server-owned fields of a draft, even from its field owner while it is editing.
    const editing = draft(A, 'editing');
    expect(await updateDoc(owner.caller, editing, { state: 'submitted' })).toBe(403);
    expect(await updateDoc(owner.caller, editing, { fieldOwnerUid: u('otherEstimatorA').uid })).toBe(403);
    expect(await updateDoc(owner.caller, editing, { submissionId: 'forged' })).toBe(403);
    expect(await updateDoc(owner.caller, editing, { field: { notes: 'x' }, state: 'submitting' })).toBe(403);
    expect(
      await createDoc(owner.caller, draft(A, 'client-made'), { fieldOwnerUid: owner.uid, state: 'editing' }),
    ).toBe(403);
    expect(await createDoc(owner.caller, draft(A, 'client-made-field'), { field: { notes: 'x' } })).toBe(403);
    expect(await deleteDoc(owner.caller, editing)).toBe(403);
    expect(
      await createDoc(owner.caller, `${editing}/rooms/extra`, {
        field: { name: 'x' },
        ocrStatus: 'verified',
      }),
    ).toBe(403);
    expect(await updateDoc(owner.caller, `${editing}/rooms/kitchen`, { ocrStatus: 'verified' })).toBe(403);
    expect(await deleteDoc(owner.caller, `${editing}/rooms/kitchen`)).toBe(403);
  });

  it('refuses writes to a draft that is no longer editing, and still lets it be read', async () => {
    const owner = u('estimatorA').caller;
    for (const id of ['submitting', 'submitted']) {
      expect(await updateDoc(owner, draft(A, id), { field: { notes: 'late edit' } }), id).toBe(403);
      expect(await updateDoc(owner, `${draft(A, id)}/rooms/kitchen`, { field: { name: 'x' } }), id).toBe(403);
      expect(await createDoc(owner, `${draft(A, id)}/rooms/late`, { field: { name: 'x' } }), id).toBe(403);
      expect(await getDoc(owner, draft(A, id)), id).toBe(200);
    }
  });

  it('refuses every path no rule names, even to the company owner', async () => {
    const ownerA = u('ownerA').caller;
    for (const path of [
      `companies/${A}`,
      access(A, u('ownerA').uid),
      `companies/${A}/jobs/j1`,
      `companies/${A}/drafts-archive/d1`,
      'drafts/d1',
      'harness/h1',
      `access/${u('ownerA').uid}`,
    ]) {
      expect(await getDoc(ownerA, path), path).toBe(403);
      expect(await createDoc(ownerA, `${path}-new`, { field: { notes: 'x' } }), path).toBe(403);
    }
    expect(await listDocs(ownerA, `companies/${A}/access`)).toBe(403);
    expect(await listDocs(ownerA, 'companies')).toBe(403);
    // Signed out, nothing at all.
    expect(await getDoc(null, draft(A, 'editing'))).toBe(403);
    expect(await updateDoc(null, draft(A, 'editing'), { field: { notes: 'x' } })).toBe(403);
  });

  it('lets office and the company owner read any draft but not write field data', async () => {
    for (const name of ['officeA', 'ownerA']) {
      const caller = u(name).caller;
      expect(await getDoc(caller, draft(A, 'editing')), name).toBe(200);
      expect(await getDoc(caller, `${draft(A, 'editing')}/rooms/kitchen`), name).toBe(200);
      expect(await listDocs(caller, `companies/${A}/drafts`), name).toBe(200);
      expect(await updateDoc(caller, draft(A, 'editing'), { field: { notes: 'x' } }), name).toBe(403);
      expect(
        await updateDoc(caller, `${draft(A, 'editing')}/rooms/kitchen`, { field: { name: 'x' } }),
        name,
      ).toBe(403);
      expect(
        await createDoc(caller, `${draft(A, 'editing')}/rooms/${name}`, { field: { name: 'x' } }),
        name,
      ).toBe(403);
    }
    // Office is refused even on a draft that names it as the field owner.
    const office = u('officeA').caller;
    expect(await updateDoc(office, draft(A, 'office-owned'), { field: { notes: 'x' } })).toBe(403);
    expect(await createDoc(office, `${draft(A, 'office-owned')}/rooms/new`, { field: { name: 'x' } })).toBe(
      403,
    );
  });

  it("refuses an estimator another estimator's draft", async () => {
    const other = u('otherEstimatorA').caller;
    expect(await getDoc(other, draft(A, 'editing'))).toBe(403);
    expect(await getDoc(other, `${draft(A, 'editing')}/rooms/kitchen`)).toBe(403);
    expect(await listDocs(other, `companies/${A}/drafts`)).toBe(403);
    expect(await updateDoc(other, draft(A, 'editing'), { field: { notes: 'x' } })).toBe(403);
    expect(await createDoc(other, `${draft(A, 'editing')}/rooms/other`, { field: { name: 'x' } })).toBe(403);
  });
});
