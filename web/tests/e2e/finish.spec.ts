import { test as base, expect as baseExpect, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { expectNoAxeViolations } from './a11y';
import { adminDb } from './offline/world';
import { PASSWORD, readSeed, type TeamAccount, type TeamSeed } from './sign-in/seed';

// The Finish and review screen (S5a-8) in Chromium and WebKit at phone width. It signs in to the
// Auth emulator's tenant of the browser project's own company and reads the job's draft from the
// Firestore emulator under the field rules, as a phone does. The jobs API needs Postgres, which this
// test server does not run, so the job, Submit and Back to editing answers are played here at the
// network boundary, as the server answers them (tests/db/submissions-api.test.ts holds the real
// routes); each test checks what the page sent: the digest of what it showed, and the same ids
// again on a retry.

const test = base;
test.use({ viewport: { width: 390, height: 844 } });
const expect = baseExpect.configure({ timeout: 20_000 });

let team: TeamSeed;
test.beforeEach(({}, testInfo) => {
  team = readSeed().teams[testInfo.project.name]!;
});

const HOUR = 60 * 60 * 1000;

const MANIFEST: FieldManifest = {
  draft: { yearBuilt: 1968, roomOrder: ['kitchen', 'hall'], summary: 'Category 2 water in two rooms.', notes: 'Under the sink.' },
  rooms: [
    { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120 } },
    { id: 'hall', field: { name: 'Hall', category: 2 } },
  ],
  photos: [{ id: randomUUID(), field: { roomId: 'kitchen', shotTag: 'source' } }],
};

// A job of the team's company with an editing draft in the field database, written as the server
// writes it, and the access record the field rules read for the person.
async function seedDraft(person: TeamAccount, role: 'owner' | 'estimator' | 'office'): Promise<{ jobId: string; draftId: string }> {
  const db = adminDb();
  const jobId = randomUUID();
  const draftId = randomUUID();
  await db.doc(`companies/${team.companyId}`).set({ authTenantId: team.tenantId }, { merge: true });
  await db.doc(`companies/${team.companyId}/access/${person.uid}`).set({ role, expiresAt: Timestamp.fromMillis(Date.now() + 24 * HOUR) });
  const draft = db.doc(`companies/${team.companyId}/drafts/${draftId}`);
  await draft.set({ fieldOwnerUid: team.estimator.uid, state: 'editing', field: MANIFEST.draft });
  for (const room of MANIFEST.rooms) await draft.collection('rooms').doc(room.id).set({ field: room.field });
  for (const photo of MANIFEST.photos) await draft.collection('photos').doc(photo.id).set({ field: photo.field });
  return { jobId, draftId };
}

type Job = { id: string; status: string; currentDraftId: string; revision: number };

// The jobs API at the network boundary: GET the job, POST Submit, POST Back to editing. `answer`
// decides each write's answer from what the page sent.
async function playJobsApi(
  page: Page,
  job: Job,
  answer: { submit?: (body: Record<string, string>, call: number) => [number, unknown] | 'abort'; drafts?: (body: Record<string, string>) => [number, unknown] },
) {
  const sent: { path: string; body: Record<string, string> }[] = [];
  let submits = 0;
  await page.route(`**/api/jobs/${job.id}**`, async (route: Route, request: Request) => {
    const path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toMatch(/^Bearer /);
    if (request.method() === 'GET' && path === `/api/jobs/${job.id}`) {
      return route.fulfill({ json: { job: { ...job, propertyAddress: '', fieldOwnerActorId: null, createdAt: '', updatedAt: '' }, customer: {}, claim: {} } });
    }
    const body = request.postDataJSON() as Record<string, string>;
    sent.push({ path, body });
    if (path.endsWith('/submissions') && answer.submit) {
      const result = answer.submit(body, (submits += 1));
      if (result === 'abort') return route.abort('connectionreset');
      return route.fulfill({ status: result[0], json: result[1] });
    }
    if (path.endsWith('/drafts') && answer.drafts) {
      const [status, json] = answer.drafts(body);
      return route.fulfill({ status, json });
    }
    return route.fulfill({ status: 500, json: { error: 'unexpected' } });
  });
  return sent;
}

async function signInTo(page: Page, who: Pick<TeamAccount, 'email'>) {
  await page.goto(`/sign-in/${team.address}`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('the estimator finishes the draft it shows, then goes back to editing', async ({ page }) => {
  const { jobId, draftId } = await seedDraft(team.estimator, 'estimator');
  const job = { id: jobId, status: 'draft', currentDraftId: draftId, revision: 2 };
  const sent = await playJobsApi(page, job, {
    submit: (body) => [201, { submission: { id: body.id, jobId, draftId, status: 'committed' }, job: { ...job, status: 'submitted', revision: 3 } }],
    drafts: (body) => [201, { job: { ...job, status: 'draft', currentDraftId: body.draftId, revision: 4 } }],
  });
  await signInTo(page, team.estimator);
  await page.goto(`/sign-in/${team.address}/jobs/${jobId}/finish`);

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Finish and review' })).toBeVisible();
  await expect(main.getByText('2 rooms: Kitchen, Hall')).toBeVisible();
  await expect(main.getByText('1 photo', { exact: true })).toBeVisible();
  await expect(main.getByText('Summary of findings written')).toBeVisible();
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  await main.getByRole('button', { name: 'Finish and review' }).click();
  await expect(main.getByRole('heading', { name: 'Finished' })).toBeVisible();
  await expect(main.getByText('This draft is recorded and locked.')).toBeVisible();
  // What the page sent: a new id, the job's current draft, and the digest of exactly what it showed.
  expect(sent).toEqual([{ path: `/api/jobs/${jobId}/submissions`, body: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), draftId, digest: await manifestDigest(MANIFEST) } }]);
  await expectNoAxeViolations(page);

  await main.getByRole('button', { name: 'Back to editing' }).click();
  await expect(main.getByText('A new draft version is ready to edit.')).toBeVisible();
  expect(sent[1]).toEqual({ path: `/api/jobs/${jobId}/drafts`, body: { draftId: expect.stringMatching(/^[0-9a-f-]{36}$/), fromDraftId: draftId } });
  await expect(main.getByRole('button', { name: 'Show the new draft' })).toBeVisible();
  await expectNoSideways(page);
});

test('a lost answer is sent again with the same id, and a changed draft starts over', async ({ page }) => {
  const { jobId, draftId } = await seedDraft(team.estimator, 'estimator');
  const job = { id: jobId, status: 'draft', currentDraftId: draftId, revision: 2 };
  const sent = await playJobsApi(page, job, {
    submit: (body, call) => {
      if (call === 1) return 'abort';
      if (call === 2) return [409, { error: 'digest_mismatch' }];
      return [201, { submission: { id: body.id }, job: { ...job, status: 'submitted' } }];
    },
  });
  await signInTo(page, team.estimator);
  await page.goto(`/sign-in/${team.address}/jobs/${jobId}/finish`);
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Finish and review' }).click();
  await expect(main.getByRole('alert')).toContainText('We could not reach DryScope.');
  await main.getByRole('button', { name: 'Try again' }).click();
  await expect(main.getByRole('alert')).toContainText('The draft changed while you were finishing');
  await expectNoAxeViolations(page);
  // The retry was the same request; after the refusal, a reload and a new id.
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  await main.getByRole('button', { name: 'Reload the job' }).click();
  await main.getByRole('button', { name: 'Finish and review' }).click();
  await expect(main.getByRole('heading', { name: 'Finished' })).toBeVisible();
  expect(sent).toHaveLength(3);
  expect(sent[2]!.body.id).not.toBe(sent[0]!.body.id);
  expect(sent[2]!.body.digest).toBe(sent[0]!.body.digest);
});

test('office sees the draft but cannot finish it', async ({ page }) => {
  const { jobId, draftId } = await seedDraft(team.office, 'office');
  const sent = await playJobsApi(page, { id: jobId, status: 'draft', currentDraftId: draftId, revision: 2 }, {});
  await signInTo(page, team.office);
  await page.goto(`/sign-in/${team.address}/jobs/${jobId}/finish`);
  const main = page.getByRole('main');
  await expect(main.getByText('2 rooms: Kitchen, Hall')).toBeVisible();
  await expect(main.getByText('Only the owner or the estimator on this job can finish it.')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Finish and review' })).toHaveCount(0);
  await expectNoAxeViolations(page);
  expect(sent).toEqual([]);
});
