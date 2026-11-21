// Field map v3 in the field rules (S7-6): the draft's `summarySource` (who wrote the summary of
// findings, `manual` or `ai`) and `aiNotes` (the AI suggestions, unpriced work and testing advice the
// technician ticked), each checked for type and size against the emulator with two sign-in tenants.
// A map the rules pass is also one the shared Zod schema reads, and a value the schema refuses the
// rules refuse too. 200 means the rules allowed the call, 403 refused it.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  draftFieldSchema,
  MAX_AI_NOTE,
  MAX_AI_SUGGESTIONS,
  MAX_AI_TESTING_ADVICE,
  MAX_AI_UNPRICED_WORK,
} from '../../../src/lib/field/schema';
import { createTenant, signIn, signUp } from '../auth-emulator';
import { type Caller, commit, type Data, serverSet, updateDoc } from './firestore-rest';

type User = { uid: string; caller: Caller };

const run = randomUUID().slice(0, 8);
const A = `v3-a-${run}`;
const B = `v3-b-${run}`;
const HOUR = 60 * 60 * 1000;

let estimatorA: User;
let estimatorB: User;

async function user(name: string, tenantId: string): Promise<User> {
  const email = `${name}-${run}@field-v3.example.test`;
  const password = `synthetic-password-${name}`;
  const uid = await signUp(tenantId, email, password);
  return { uid, caller: { idToken: await signIn(tenantId, email, password) } };
}

const draft = (company: string, id: string) => `companies/${company}/drafts/${id}`;
const notes = (n: number, size = 40) => Array.from({ length: n }, (_, i) => `${i} `.padEnd(size, 'n'));

const ACCEPTED: Data = {
  summary: 'Category 2 water from the supply line reached the kitchen and hall.',
  summarySource: 'ai',
  aiNotes: {
    suggestions: ['Check the subfloor under the dishwasher.'],
    unpricedWork: ['Replace the toe kick, 8 linear feet.'],
    testingAdvice: ['Test the drywall joint compound for asbestos before cutting.'],
  },
};
// Every list at its longest, every note at its largest size.
const LARGEST: Data = {
  summarySource: 'manual',
  aiNotes: {
    suggestions: notes(MAX_AI_SUGGESTIONS, MAX_AI_NOTE),
    unpricedWork: notes(MAX_AI_UNPRICED_WORK, MAX_AI_NOTE),
    testingAdvice: notes(MAX_AI_TESTING_ADVICE, MAX_AI_NOTE),
  },
};

beforeAll(async () => {
  const tenantA = await createTenant('v3-a');
  const tenantB = await createTenant('v3-b');
  estimatorA = await user('estimatorA', tenantA);
  estimatorB = await user('estimatorB', tenantB);
  await serverSet(`companies/${A}`, { authTenantId: tenantA });
  await serverSet(`companies/${B}`, { authTenantId: tenantB });
  const expiresAt = new Date(Date.now() + HOUR);
  await serverSet(`companies/${A}/access/${estimatorA.uid}`, { role: 'estimator', expiresAt });
  await serverSet(`companies/${B}/access/${estimatorB.uid}`, { role: 'estimator', expiresAt });
  await serverSet(draft(A, 'editing'), { fieldOwnerUid: estimatorA.uid, state: 'editing', field: {} });
  await serverSet(draft(A, 'submitting'), { fieldOwnerUid: estimatorA.uid, state: 'submitting', field: {} });
  await serverSet(draft(B, 'editing'), { fieldOwnerUid: estimatorB.uid, state: 'editing', field: {} });
});

describe('field map v3 draft rules', () => {
  it('accepts an accepted AI draft, a manual summary and every list at its largest in each company, and Zod reads them', async () => {
    const maps: Data[] = [ACCEPTED, LARGEST, { summary: 'Typed on site.', summarySource: 'manual' }, { aiNotes: {} }, { aiNotes: { suggestions: [] } }];
    for (const field of maps) expect(draftFieldSchema.safeParse(field).success, JSON.stringify(field).slice(0, 80)).toBe(true);
    for (const [company, who] of [
      [A, estimatorA],
      [B, estimatorB],
    ] as const) {
      for (const field of maps) expect(await updateDoc(who.caller, draft(company, 'editing'), { field }), company).toBe(200);
    }
  });

  it("refuses the same map from company B's estimator on company A's draft, and on a draft that is submitting", async () => {
    expect(await updateDoc(estimatorB.caller, draft(A, 'editing'), { field: ACCEPTED })).toBe(403);
    expect(await updateDoc(estimatorA.caller, draft(A, 'submitting'), { field: ACCEPTED })).toBe(403);
    expect(await commit(estimatorA.caller, [{ path: draft(A, 'submitting'), data: { field: ACCEPTED } }])).toBe(403);
  });

  it('refuses a summary source other than manual or ai', async () => {
    for (const summarySource of ['AI', 'model', '', true, 1, null, ['ai'], { ai: true }]) {
      const field = { summary: 'x', summarySource };
      expect(draftFieldSchema.safeParse(field).success, JSON.stringify(summarySource)).toBe(false);
      expect(await updateDoc(estimatorA.caller, draft(A, 'editing'), { field }), JSON.stringify(summarySource)).toBe(403);
    }
  });

  it('refuses AI notes that are not a map of the three lists', async () => {
    for (const aiNotes of [
      ['Check the subfloor.'],
      'Check the subfloor.',
      null,
      { summary: 'x' },
      { suggestions: ['ok'], prices: ['$40'] },
      { unpriced_work: ['Replace the toe kick.'] },
      { suggestions: 'Check the subfloor.' },
      { testingAdvice: { 0: 'Test first.' } },
    ]) {
      const label = JSON.stringify(aiNotes);
      expect(draftFieldSchema.safeParse({ aiNotes }).success, label).toBe(false);
      expect(await updateDoc(estimatorA.caller, draft(A, 'editing'), { field: { aiNotes } }), label).toBe(403);
    }
  });

  it('refuses a list that is too long, and a note that is empty, too long, not text or holds a line break, at every place', async () => {
    const lists = [
      ['suggestions', MAX_AI_SUGGESTIONS],
      ['unpricedWork', MAX_AI_UNPRICED_WORK],
      ['testingAdvice', MAX_AI_TESTING_ADVICE],
    ] as const;
    for (const [key, max] of lists) {
      const full = notes(max);
      for (const list of [
        notes(max + 1),
        [''],
        ['n'.repeat(MAX_AI_NOTE + 1)],
        [7],
        [null],
        [{ note: 'x' }],
        ['Two\nlines'],
        ['Ends with a break\n'],
        // A bad note among good ones, first and last.
        ['', ...full.slice(1)],
        [...full.slice(0, -1), 'n'.repeat(MAX_AI_NOTE + 1)],
        [...full.slice(0, -1), 42],
        [...full.slice(0, -1), 'a\nb'],
      ]) {
        const aiNotes = { [key]: list };
        const label = `${key} ${JSON.stringify(list).slice(0, 60)} (${list.length})`;
        expect(draftFieldSchema.safeParse({ aiNotes }).success, label).toBe(false);
        expect(await updateDoc(estimatorA.caller, draft(A, 'editing'), { field: { aiNotes } }), label).toBe(403);
      }
    }
  });

  it('accepts the v3 keys beside every v1 key in one write, so the rules stay within their limits', async () => {
    const field: Data = {
      yearBuilt: 1972,
      roomOrder: [],
      notes: 'n'.repeat(40_000),
      summary: 's'.repeat(6_000),
      scopeConfirmed: true,
      airMovers: 4,
      dehumidifiers: 1,
      airScrubbers: 1,
      dryingDays: 3,
      woodFloorSystems: 0,
      woodFloorDays: 7,
      emergencyCalls: 1,
      monitoringHours: 13.25,
      haulLoads: 1,
      hepaFilters: 1,
      matterportScans: 0,
      dumpTruckLoads: 0,
      equipmentDecon: 0,
      powerDistribution: 0,
      laborHours: 2.5,
      isAfterHours: false,
      ...LARGEST,
    };
    expect(draftFieldSchema.safeParse(field).success).toBe(true);
    expect(await updateDoc(estimatorA.caller, draft(A, 'editing'), { field })).toBe(200);
  });
});
