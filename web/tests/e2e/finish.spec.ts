import { test as base, expect as baseExpect, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, seedCompany } from './jobs/seed';
import { adminDb } from './offline/world';
import { APP_CODE, fakeSecondStep } from './second-step/fake-totp';
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

// An owner or office user signs in with the authenticator app (D2), which the Auth emulator cannot
// do: it is answered at the network boundary (second-step/fake-totp.ts), so the token the page
// shows the field rules carries the second step, as Identity Platform's does.
async function signInTo(page: Page, who: Pick<TeamAccount, 'email'>, secondStep = false) {
  if (secondStep) await fakeSecondStep(page, { factors: ['Authenticator app'] });
  await page.goto(`/sign-in/${team.address}`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (secondStep) {
    await page.getByLabel('6-digit code').fill(APP_CODE);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
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

test('when another phone finished first, a reload shows the record and Back to editing', async ({ page }) => {
  const { jobId, draftId } = await seedDraft(team.estimator, 'estimator');
  const job = { id: jobId, status: 'draft', currentDraftId: draftId, revision: 2 };
  await playJobsApi(page, job, {
    submit: () => {
      // The other phone's Submit is already recorded on the server.
      job.status = 'submitted';
      job.revision = 3;
      return [409, { error: 'already_submitted' }];
    },
  });
  await signInTo(page, team.estimator);
  await page.goto(`/sign-in/${team.address}/jobs/${jobId}/finish`);
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Finish and review' }).click();
  await expect(main.getByRole('alert')).toContainText('This draft is already finished.');
  await main.getByRole('button', { name: 'Reload the job' }).click();
  await expect(main.getByRole('heading', { name: 'Finished' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Back to editing' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Finish and review' })).toHaveCount(0);
});

test('office sees the draft but cannot finish it', async ({ page }) => {
  const { jobId, draftId } = await seedDraft(team.office, 'office');
  const sent = await playJobsApi(page, { id: jobId, status: 'draft', currentDraftId: draftId, revision: 2 }, {});
  await signInTo(page, team.office, true);
  await page.goto(`/sign-in/${team.address}/jobs/${jobId}/finish`);
  const main = page.getByRole('main');
  await expect(main.getByText('2 rooms: Kitchen, Hall')).toBeVisible();
  await expect(main.getByText('Only the owner or the estimator on this job can finish it.')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Finish and review' })).toHaveCount(0);
  await expectNoAxeViolations(page);
  expect(sent).toEqual([]);
});

test.describe('Ready to review', () => {
  test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 320, height: 720 } });

  async function openJob(page: Page, flag = true) {
    const company = await seedCompany('readiness', { estimator: 'estimator', office: 'office' });
    if (flag) await adminSql()`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company.id}, 'readiness', true)`;
    const signIn = async (role: 'estimator' | 'office') => {
      if (role === 'office') await fakeSecondStep(page, { factors: ['Authenticator app'] });
      await page.goto(`/sign-in/${company.address}`);
      await page.getByLabel('Email').fill(company.people[role]!.email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      if (role === 'office') {
        await page.getByLabel('6-digit code').fill(APP_CODE);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      }
      await expect(page.getByRole('link', { name: 'Open the field app' })).toBeVisible();
    };
    await signIn('estimator');
    await page.getByRole('link', { name: 'Open the field app' }).click();
    await page.getByRole('button', { name: 'Online only', exact: true }).click();
    await page.getByRole('link', { name: 'New job' }).click();
    await page.getByLabel('Property address').fill('15 Example Street');
    await page.getByRole('button', { name: 'Start job' }).click();
    await expect(page.getByLabel('Year built')).toBeEditable();
    const jobId = new URL(page.url()).searchParams.get('job')!;
    return { company, jobId, finishPath: `/sign-in/${company.address}/jobs/${jobId}/finish`, signIn };
  }

  function checked(page: Page, jobId: string, finishPath: string) {
    return page.waitForResponse((answer) => {
      const from = answer.request().headers().referer;
      return Boolean(from && new URL(from).pathname === finishPath && new URL(answer.url()).pathname === `/api/jobs/${jobId}/readiness` && answer.ok());
    });
  }

  test('Fix opens the saved field and Continue anyway commits one submission', async ({ page }) => {
    const { jobId, finishPath } = await openJob(page);
    await page.getByLabel('New room name').fill('Kitchen');
    await page.getByRole('button', { name: 'Add room' }).click();
    await expect(page.getByText('Kitchen added.')).toBeVisible();
    const yearGap = 'Add the year built';
    const button = page.getByRole('button', { name: 'Finish and review' });
    const dialog = page.getByRole('dialog', { name: 'Ready to review?' });
    const sent: Request[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/jobs/${jobId}/submissions`) sent.push(request);
    });

    const first = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    expect((await (await first).json()).gaps).toContainEqual({ code: 'yearBuilt' });
    await button.focus();
    await button.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused();
    await expectNoSideways(page);
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    expect(sent).toHaveLength(0);

    await button.click();
    await dialog.getByRole('link', { name: `Fix: ${yearGap}` }).click();
    const year = page.getByLabel('Year built');
    await expect(year).toBeFocused();
    await year.fill('1985');
    await page.getByRole('button', { name: 'Save scope' }).click();
    await expect(page.getByText('Scope saved.')).toBeVisible();
    const updated = checked(page, jobId, finishPath);
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    expect((await (await updated).json()).gaps.map((gap: { code: string }) => gap.code)).not.toContain('yearBuilt');
    await button.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(yearGap)).toHaveCount(0);
    await dialog.getByRole('link', { name: 'Fix: Kitchen: Choose water category or mold' }).click();
    await expect(page.getByRole('form', { name: 'Kitchen' }).getByRole('heading')).toBeFocused();

    const forPhotos = checked(page, jobId, finishPath);
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    await (await forPhotos).finished();
    await button.click();
    await dialog.getByRole('link', { name: 'Fix: Kitchen: Add an overview photo' }).click();
    const room = page.getByLabel('Room', { exact: true });
    await expect(room).toBeFocused();
    await expect(room.locator('option:checked')).toHaveText('Kitchen');
    await expect(page.getByLabel('Shot')).toHaveValue('overview');

    const checkedAgain = checked(page, jobId, finishPath);
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    await (await checkedAgain).finished();
    await button.click();
    await dialog.getByRole('button', { name: 'Continue anyway' }).click();
    await expect(page.getByRole('heading', { name: 'Finished', exact: true })).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method()).toBe('POST');
    expect(await (await sent[0]?.response())?.status()).toBe(201);
  });

  for (const mode of ['flag off', 'no gaps', 'stale digest', 'failure', 'pending'] as const) {
    test(`${mode} leaves Finish available without a prompt`, async ({ page }) => {
      const { jobId, finishPath } = await openJob(page, mode !== 'flag off');
      let calls = 0;
      const pending = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      await page.route(`**/api/jobs/${jobId}/readiness`, async (route) => {
        calls += 1;
        requested.resolve();
        if (mode === 'pending') {
          await pending.promise;
          return route.abort();
        }
        if (mode === 'failure') return route.fulfill({ status: 503 });
        const response = await route.fetch();
        const json = await response.json();
        if (mode === 'no gaps') Object.assign(json, { ready: true, gaps: [], unavailable: ['ocr'] });
        if (mode === 'stale digest') json.fieldSha256 = 'f'.repeat(64);
        await route.fulfill({ response, json });
      });
      const answered = mode === 'no gaps' || mode === 'stale digest' || mode === 'failure'
        ? page.waitForResponse((response) => new URL(response.url()).pathname === `/api/jobs/${jobId}/readiness`)
        : null;
      try {
        await page.goto(finishPath);
        if (answered) await (await answered).finished();
        if (mode === 'pending') await requested.promise;
        await page.getByRole('button', { name: 'Finish and review' }).click();
        await expect(page.getByRole('heading', { name: 'Finished', exact: true })).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'Ready to review?' })).toHaveCount(0);
        expect(calls).toBe(mode === 'flag off' ? 0 : 1);
      } finally {
        pending.resolve();
      }
    });
  }

  test('a late readiness answer is dropped on sign-out', async ({ page, context }) => {
    const { company, jobId, finishPath } = await openJob(page);
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(`**/api/jobs/${jobId}/readiness`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      requested.resolve();
      await release.promise;
      await route.fulfill({ response }).catch(() => undefined);
    });
    try {
      await page.goto(finishPath);
      await requested.promise;
      const signIn = await context.newPage();
      await signIn.goto(`/sign-in/${company.address}`);
      await signIn.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(signIn.getByRole('heading', { name: `Sign in to ${company.name}` })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Sign in to finish this job' })).toBeVisible();
    } finally {
      release.resolve();
    }
    await expect(page.getByRole('dialog', { name: 'Ready to review?' })).toHaveCount(0);
  });

  test('office opens Finish without requesting readiness', async ({ page }) => {
    const { company, finishPath, jobId, signIn } = await openJob(page);
    await page.goto(`/sign-in/${company.address}`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Sign in to ${company.name}` })).toBeVisible();
    await signIn('office');
    const requests: Request[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/jobs/${jobId}/readiness`) requests.push(request);
    });
    await page.goto(finishPath);
    await expect(page.getByText('Only the owner or the estimator on this job can finish it.')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Ready to review?' })).toHaveCount(0);
    expect(requests).toHaveLength(0);
  });
});
