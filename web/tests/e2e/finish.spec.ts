import { test as base, expect as baseExpect, type APIRequestContext, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { completeJob } from './jobs/complete-job';
import { adminSql, currentDraftOf, seedCompany, type Company } from './jobs/seed';
import { adminDb } from './offline/world';
import { APP_CODE, fakeSecondStep, withSecondFactor } from './second-step/fake-totp';
import { idTokenFor } from './sign-in/emulator';
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

  async function openJob(page: Page, flag = true, storage = 'Online only') {
    const company = await seedCompany('readiness', { estimator: 'estimator', office: 'office', owner: 'owner' });
    if (flag) await adminSql()`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company.id}, 'readiness', true)`;
    const signIn = async (role: 'estimator' | 'office' | 'owner') => {
      const secondStep = role !== 'estimator';
      if (secondStep) await fakeSecondStep(page, { factors: ['Authenticator app'] });
      await page.goto(`/sign-in/${company.address}`);
      await page.getByLabel('Email').fill(company.people[role]!.email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      if (secondStep) {
        await page.getByLabel('6-digit code').fill(APP_CODE);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      }
      await expect(page.getByRole('link', { name: 'Open the field app' })).toBeVisible();
    };
    await signIn('estimator');
    await page.getByRole('link', { name: 'Open the field app' }).click();
    await page.getByRole('button', { name: storage, exact: true }).click();
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

  async function followYearFix(page: Page, jobId: string, finishPath: string) {
    const first = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    await (await first).finished();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await page.getByRole('dialog', { name: 'Ready to review?' }).getByRole('link', { name: 'Fix: Add the year built' }).click();
  }

  test('the return waits for a sent claim and rechecks hidden edits before leaving', async ({ page }) => {
    const { jobId, finishPath } = await openJob(page);
    await followYearFix(page, jobId, finishPath);
    const year = page.getByLabel('Year built');
    await expect(year).toBeEditable();
    await page.getByRole('link', { name: 'Customer and claim' }).click();
    const claim = page.getByLabel('Claim number');
    await claim.fill('Claim 123');
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(`**/api/jobs/${jobId}/claim`, async (route) => {
      if (route.request().method() === 'PUT') {
        started.resolve();
        await release.promise;
      }
      await route.continue();
    });

    const back = page.getByRole('link', { name: 'Back to Finish and review' });
    const warning = page.getByRole('alert').filter({ hasText: 'Some changes are not saved' });
    try {
      await page.getByRole('button', { name: 'Save claim' }).click();
      await started.promise;
      await back.click();
      await expect(page.getByRole('status').filter({ hasText: /^Saving…$/ })).toBeVisible();
      expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(false);
      await page.getByRole('link', { name: 'Check Scope' }).click();
      await year.fill('1985');
    } finally {
      release.resolve();
    }
    await expect(warning).toBeVisible();
    await expect(year).toHaveValue('1985');
    await warning.getByRole('button', { name: 'Discard changes and go back' }).click();
    await expect(page).toHaveURL(new RegExp(`${finishPath}$`));
  });

  test('browser Back warns about unsaved Fix edits and cancel keeps them', async ({ page }) => {
    const { jobId, finishPath } = await openJob(page);
    await followYearFix(page, jobId, finishPath);
    const year = page.getByLabel('Year built');
    await year.click();
    await year.fill('1985');
    const warned = page.waitForEvent('dialog');
    const back = page.evaluate(() => window.history.back());
    const dialog = await warned;
    await dialog.dismiss();
    await back;
    expect(dialog.type()).toBe('beforeunload');
    await expect(page).toHaveURL(/\/field\?/);
    await expect(year).toHaveValue('1985');
    await year.fill('');
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    await expect(page).toHaveURL(new RegExp(`${finishPath}$`));
  });

  test('a stalled journal read stops the return and keeps the Fix destination', async ({ page }) => {
    const { jobId, finishPath } = await openJob(page, true, 'Keep jobs on this phone');
    await followYearFix(page, jobId, finishPath);
    const year = page.getByLabel('Year built');
    await expect(year).toBeEditable();
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const opened = transaction.apply(this, args);
        if (this.name === 'ds-journal' && opened.mode === 'readonly') {
          Object.defineProperty(opened, 'oncomplete', { set: () => undefined });
        }
        return opened;
      };
    });
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Saving…$/ })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not confirm that the changes were saved' })).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/field\?/);
    await expect(year).toBeEditable();
  });

  test('a queued edit from an older app still blocks return by its draft path', async ({ page }) => {
    const { company, jobId, finishPath } = await openJob(page, true, 'Keep jobs on this phone');
    await followYearFix(page, jobId, finishPath);
    await expect(page.getByLabel('Year built')).toBeEditable();
    const draftPath = `companies/${company.id}/drafts/${await currentDraftOf(company.id, jobId)}`;
    await page.evaluate(({ tenantId, uid, draftPath }) => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('ds-journal', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('entries', 'readwrite');
        transaction.onabort = () => reject(transaction.error);
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.objectStore('entries').add({
          id: crypto.randomUUID(), tenantId, uid, draftPath, at: Date.now(), state: 'pending',
          writes: [{ path: draftPath, op: 'update', fields: { 'field.yearBuilt': 1985 } }],
        });
      };
    }), { tenantId: company.tenantId, uid: company.people.estimator!.uid, draftPath });
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not confirm that the changes were saved' })).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/field\?/);
  });

  test('discard clears mounted forms and cancelling the return keeps the photo upload', async ({ page }) => {
    const { jobId, finishPath } = await openJob(page);
    await page.getByLabel('New room name').fill('Kitchen');
    await page.getByRole('button', { name: 'Add room' }).click();
    await expect(page.getByText('Kitchen added.')).toBeVisible();
    await followYearFix(page, jobId, finishPath);
    const year = page.getByLabel('Year built');
    const roomName = page.getByLabel('New room name');
    const kitchen = page.getByRole('form', { name: 'Kitchen' }).getByLabel('Room name');
    const customer = page.getByLabel('Customer name');
    const claim = page.getByLabel('Claim number');
    const back = page.getByRole('link', { name: 'Back to Finish and review' });
    await expect(year).toBeEditable();
    await page.getByRole('link', { name: 'Photos' }).click();
    await page.evaluate(() => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      const ready = new Promise<void>((resolve) => document.addEventListener('release-test-photo', () => resolve(), { once: true }));
      HTMLCanvasElement.prototype.toBlob = function (...args) {
        void ready.then(() => toBlob.apply(this, args));
      };
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstSend = true;
    await page.route(`**/api/jobs/${jobId}/photos/*?kind=photo`, async (route) => {
      if (route.request().method() !== 'PUT' || !firstSend) return route.continue();
      firstSend = false;
      started.resolve();
      await release.promise;
      await route.abort();
    });
    try {
      await page.getByLabel('Take photo').setInputFiles({
        name: 'overview.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAZ0lEQVR4nBWMQQ0AQAyDqmRKqgQlU1IlU1JFl+NJCBIaZARaFHSoSGKGMQOzTJhjykh4sDF4cfDhYokfm89C4KAgscP6y1027LFlJTLEP82SkCMlEjec/+CWC3dcOYkO9d92aejR0gf/sEsBLaIzfQAAAABJRU5ErkJggg==', 'base64'),
      });
      await back.click();
      await expect(page.getByRole('status').filter({ hasText: /^Saving…$/ })).toBeVisible();
      await page.getByRole('button', { name: 'Keep editing' }).click();
      await page.evaluate(() => document.dispatchEvent(new Event('release-test-photo')));
      await started.promise;
      await page.getByRole('link', { name: 'Check Scope' }).click();
      await year.fill('1985');
      await roomName.fill('Garage');
      await kitchen.fill('Kitchen edit');
      await page.getByRole('link', { name: 'Customer and claim' }).click();
      await customer.fill('Test customer');
      await claim.fill('Claim 123');
      await back.click();
      await page.getByRole('button', { name: 'Discard changes and go back' }).click();
      await page.getByRole('button', { name: 'Keep editing' }).click();
      await expect(customer).toHaveValue('');
      await expect(claim).toHaveValue('');
      await page.getByRole('link', { name: 'Check Scope' }).click();
      await expect(year).toHaveValue('');
      await expect(roomName).toHaveValue('');
      await expect(kitchen).toHaveValue('Kitchen');
      await page.getByRole('link', { name: 'Photos' }).click();
      await expect(page.getByText('Sending the photo…')).toBeVisible();
      await back.click();
      await expect(page.getByRole('status').filter({ hasText: /^Saving…$/ })).toBeVisible();
    } finally {
      release.resolve();
    }
    await expect(page.getByRole('alert').filter({ hasText: 'Could not confirm that the changes were saved' })).toBeVisible();
    const retry = page.getByRole('button', { name: 'Send again' });
    await retry.click();
    await expect(retry).toBeHidden();
    await back.click();
    await expect(page).toHaveURL(new RegExp(`${finishPath}$`));
    await expect(page.getByText('1 photo', { exact: true })).toBeVisible();
  });

  test('turning readiness off after following Fix still allows the return', async ({ page }) => {
    const { company, jobId, finishPath } = await openJob(page);
    await followYearFix(page, jobId, finishPath);
    const year = page.getByLabel('Year built');
    await expect(year).toBeFocused();
    const marker = page.getByRole('status').filter({ hasText: /^\d+ items? to check$/ });
    await expect(marker).toBeVisible();
    await adminSql()`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${company.id} AND flag = 'readiness'`;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(marker).toBeHidden();
    const reread = page.waitForResponse((answer) => new URL(answer.url()).pathname === '/api/me' && answer.ok());
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'visibilityState');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect((await (await reread).json()).features?.readiness).not.toBe(true);
    await expect(year).toBeEditable();
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    await expect(page).toHaveURL(new RegExp(`${finishPath}$`));
    await expect(page.getByRole('button', { name: 'Finish and review' })).toBeVisible();
    await expect(page.locator('dialog')).toHaveCount(0);
  });

  test('Company jobs skips readiness for another person’s rows but Finish keeps their current checklist', async ({ page }) => {
    const { company, jobId, finishPath, signIn } = await openJob(page);
    await page.goto(`/sign-in/${company.address}`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Sign in to ${company.name}` })).toBeVisible();
    await signIn('owner');
    await page.getByRole('link', { name: 'Open the field app' }).click();
    const choice = page.getByRole('button', { name: 'Online only', exact: true });
    const newJob = page.getByRole('link', { name: 'New job' });
    await expect(choice.or(newJob)).toBeVisible();
    if (await choice.isVisible()) await choice.click();
    await newJob.click();
    await page.getByLabel('Property address').fill('17 Example Street');
    await page.getByRole('button', { name: 'Start job' }).click();
    await expect(page.getByLabel('Year built')).toBeEditable();
    const ownJob = new URL(page.url()).searchParams.get('job')!;
    const checks: string[] = [];
    const observe = (request: Request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith('/readiness')) checks.push(pathname);
    };
    page.on('request', observe);
    await page.getByRole('link', { name: 'Back to jobs' }).click();
    const companyJobs = page.getByRole('list', { name: 'Company jobs' });
    await expect(companyJobs.getByText('15 Example Street')).toBeVisible();
    await expect(companyJobs.getByRole('listitem').filter({ hasText: '17 Example Street' }).getByText(/to check/)).toBeVisible();
    expect(checks).toEqual([`/api/jobs/${ownJob}/readiness`]);
    page.off('request', observe);

    const first = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    await (await first).finished();
    const finish = page.getByRole('button', { name: 'Finish and review' });
    const dialog = page.getByRole('dialog', { name: 'Ready to review?' });
    await finish.click();
    const refused = page.waitForResponse((answer) => new URL(answer.url()).pathname === `/api/jobs/${jobId}/submissions`);
    await dialog.getByRole('button', { name: 'Continue anyway' }).click();
    expect(await (await refused).json()).toMatchObject({ error: 'not_field_owner' });
    await expect(page.getByRole('alert').filter({ hasText: 'Reload the job' })).toBeVisible();
    await finish.click();
    await expect(dialog.getByRole('link', { name: 'Fix: Add the year built' })).toBeVisible();
  });

  test('with readiness off, an ownership refusal appears without another job read', async ({ page }) => {
    const { company, jobId, finishPath, signIn } = await openJob(page, false);
    await page.goto(`/sign-in/${company.address}`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Sign in to ${company.name}` })).toBeVisible();
    await signIn('owner');
    await page.goto(finishPath);
    const finish = page.getByRole('button', { name: 'Finish and review' });
    await expect(finish).toBeEnabled();

    const release = Promise.withResolvers<void>();
    let jobReads = 0;
    await page.route(`**/api/jobs/${jobId}`, async (route) => {
      jobReads += 1;
      await release.promise;
      await route.continue();
    });
    try {
      const refused = page.waitForResponse((answer) => new URL(answer.url()).pathname === `/api/jobs/${jobId}/submissions`);
      await finish.click();
      const answer = await refused;
      expect(answer.status()).toBe(403);
      expect(await answer.json()).toMatchObject({ error: 'not_field_owner' });
      await expect(page.getByRole('alert').filter({ hasText: 'Reload the job' })).toBeVisible();
      expect(jobReads).toBe(0);
    } finally {
      release.resolve();
    }
  });

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
    const needed = page.getByRole('list', { name: 'Baseline photos still needed' });
    await expect(needed.getByRole('button')).toHaveText(['Add an overview photo', 'Add an affected surface photo', 'Add a moisture meter photo']);
    await needed.getByRole('button', { name: 'Add a moisture meter photo' }).click();
    await expect(page.getByLabel('Shot')).toHaveValue('meter');
    await page.getByLabel('Shot').selectOption('overview');

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(`**/api/jobs/${jobId}/photos/*?kind=photo`, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      started.resolve();
      await release.promise;
      await route.continue();
    });
    const checkedAgain = checked(page, jobId, finishPath);
    try {
      await page.getByLabel('Take photo').setInputFiles({
        name: 'overview.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAZ0lEQVR4nBWMQQ0AQAyDqmRKqgQlU1IlU1JFl+NJCBIaZARaFHSoSGKGMQOzTJhjykh4sDF4cfDhYokfm89C4KAgscP6y1027LFlJTLEP82SkCMlEjec/+CWC3dcOYkO9d92aejR0gf/sEsBLaIzfQAAAABJRU5ErkJggg==', 'base64'),
      });
      await started.promise;
      await page.getByRole('link', { name: 'Back to Finish and review' }).click();
      await expect(page.getByText('Saving…', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/field\?/);
    } finally {
      release.resolve();
    }
    expect((await (await checkedAgain).json()).gaps.map((gap: { code: string }) => gap.code)).not.toContain('shot:overview');
    await button.click();
    await dialog.getByRole('button', { name: 'Continue anyway' }).click();
    await expect(page.getByRole('heading', { name: 'Finished', exact: true })).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method()).toBe('POST');
    expect(await (await sent[0]?.response())?.status()).toBe(201);
  });

  for (const mode of ['flag off', 'failure', 'pending'] as const) {
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
        if (mode === 'failure') return route.abort('failed');
        await route.continue();
      });
      const failed = mode === 'failure'
        ? page.waitForEvent('requestfailed', (request) => new URL(request.url()).pathname === `/api/jobs/${jobId}/readiness`)
        : null;
      try {
        await page.goto(finishPath);
        if (failed) await failed;
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

  async function openField(page: Page, jobId: string) {
    await page.goto(`/field?job=${jobId}`);
    const choice = page.getByRole('button', { name: 'Online only', exact: true });
    const year = page.getByLabel('Year built');
    await expect(year.or(choice)).toBeVisible();
    if (await choice.isVisible()) await choice.click();
    await expect(year).toBeEditable();
  }

  test('a complete job shows Ready to review on the field screens and Finish submits it directly', async ({ page }) => {
    const { company, jobId, finishPath } = await openJob(page);
    await completeJob(company, jobId);
    const sent: Request[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/jobs/${jobId}/submissions`) sent.push(request);
    });

    await openField(page, jobId);
    await expect(page.getByRole('status').filter({ hasText: 'Ready to review' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to jobs' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: '15 Example Street' }).getByText('Ready to review', { exact: true })).toBeVisible();

    const answered = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    expect(await (await answered).json()).toMatchObject({ status: 'checked', ready: true, gaps: [] });
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('heading', { name: 'Finished', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Ready to review?' })).toHaveCount(0);
    expect(sent).toHaveLength(1);
  });

  test('an answer about a newer version of the draft is not trusted and Finish is sent as it is', async ({ page }) => {
    const { company, jobId, finishPath } = await openJob(page);
    const { draftId } = await completeJob(company, jobId);
    const sent: Request[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/jobs/${jobId}/submissions`) sent.push(request);
    });
    const requested = Promise.withResolvers<void>();
    const changed = Promise.withResolvers<void>();
    await page.route(`**/api/jobs/${jobId}/readiness`, async (route) => {
      requested.resolve();
      await changed.promise;
      await route.continue();
    });
    const answered = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/jobs/${jobId}/readiness`);
    try {
      await page.goto(finishPath);
      await requested.promise;
      expect(await currentDraftOf(company.id, jobId)).toBe(draftId);
      await adminDb().doc(`companies/${company.id}/drafts/${draftId}`).update({ 'field.yearBuilt': FieldValue.delete() });
    } finally {
      changed.resolve();
    }
    expect(await (await answered).json()).toMatchObject({ status: 'checked', ready: false, gaps: [{ code: 'yearBuilt' }] });
    await (await answered).finished();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('dialog', { name: 'Ready to review?' })).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(1);
    expect((await sent[0]!.response())?.status()).toBe(409);
  });

  test('the way back to Finish keeps unsaved edits until the person chooses and stays on every tab', async ({ page }) => {
    const { jobId, finishPath } = await openJob(page);
    const first = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    await (await first).finished();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await page.getByRole('dialog', { name: 'Ready to review?' }).getByRole('link', { name: 'Fix: Add the year built' }).click();
    const year = page.getByLabel('Year built');
    await expect(year).toBeFocused();
    await year.fill('1985');

    await page.getByRole('link', { name: 'Photos' }).click();
    await page.getByRole('link', { name: 'Check Scope' }).click();
    await expect(year).toHaveValue('1985');
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    const warning = page.getByRole('alert').filter({ hasText: 'Some changes are not saved' });
    await expect(warning).toBeVisible();
    await warning.getByRole('button', { name: 'Keep editing' }).click();
    await expect(warning).toHaveCount(0);
    await expect(year).toHaveValue('1985');

    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    const again = checked(page, jobId, finishPath);
    await page.getByRole('button', { name: 'Discard changes and go back' }).click();
    await expect(page).toHaveURL(new RegExp(`${finishPath}$`));
    await (await again).finished();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('dialog', { name: 'Ready to review?' }).getByText('Add the year built')).toBeVisible();
  });

  test('an owner reading an estimator’s job with no rooms lands on the Rooms heading, and the price link needs prices_manage', async ({ page }) => {
    const { company, jobId, finishPath, signIn } = await openJob(page);
    await page.goto(`/sign-in/${company.address}`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Sign in to ${company.name}` })).toBeVisible();
    await signIn('owner');
    const answered = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    await (await answered).finished();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ready to review?' });
    await expect(dialog.getByRole('link', { name: /^Open Prices:/ })).toHaveCount(0);
    await expect(dialog.getByText('Publish company prices before pricing this job.')).toBeVisible();
    await dialog.getByRole('link', { name: 'Fix: Add an affected room' }).click();
    const choice = page.getByRole('button', { name: 'Online only', exact: true });
    const rooms = page.getByRole('heading', { name: 'Rooms', exact: true });
    await expect(rooms.or(choice)).toBeVisible();
    if (await choice.isVisible()) await choice.click();
    await expect(rooms).toBeFocused();
  });

  // The owner archives the job through the app's own route.
  async function archiveAsOwner(request: APIRequestContext, company: Company, jobId: string) {
    const token = await idTokenFor(company.tenantId, company.people.owner!.email, PASSWORD);
    const archived = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/archive`, {
      headers: { Authorization: `Bearer ${withSecondFactor(token)}` },
      data: { revision: 1, changeId: randomUUID() },
    });
    expect(archived.status()).toBe(200);
  }

  test('a job archived while its readiness check is pending shows the archived notice, not an unavailable check', async ({ page, request }) => {
    const { company, jobId } = await openJob(page);
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(`**/api/jobs/${jobId}/readiness`, async (route) => {
      requested.resolve();
      await release.promise;
      await route.continue().catch(() => undefined);
    });
    try {
      await page.goto(`/field?job=${jobId}`);
      const choice = page.getByRole('button', { name: 'Online only', exact: true });
      await expect(page.getByLabel('Year built').or(choice)).toBeVisible();
      if (await choice.isVisible()) await choice.click();
      await requested.promise;
      await archiveAsOwner(request, company, jobId);
    } finally {
      release.resolve();
    }
    await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
    await expect(page.getByText('Readiness check unavailable.')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to Finish and review' })).toHaveCount(0);
  });

  test('Continue anyway on a job archived meanwhile shows the archived state and no checklist', async ({ page, request }) => {
    const { company, jobId, finishPath } = await openJob(page);
    const first = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    await (await first).finished();
    const button = page.getByRole('button', { name: 'Finish and review' });
    const dialog = page.getByRole('dialog', { name: 'Ready to review?' });
    await button.click();
    await expect(dialog).toBeVisible();
    await archiveAsOwner(request, company, jobId);
    await dialog.getByRole('button', { name: 'Continue anyway' }).click();
    await expect(page.getByRole('heading', { name: 'This job is archived', exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(button).toHaveCount(0);
  });

  test('a room name typed and discarded does not come back with the next Fix', async ({ page }) => {
    const { jobId, finishPath } = await openJob(page);
    const first = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    await (await first).finished();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await page.getByRole('dialog', { name: 'Ready to review?' }).getByRole('link', { name: 'Fix: Add an affected room' }).click();
    const name = page.getByLabel('New room name');
    await name.fill('Garage');
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    const returned = checked(page, jobId, finishPath);
    await page.getByRole('button', { name: 'Discard changes and go back' }).click();
    await expect(page).toHaveURL(new RegExp(`${finishPath}$`));
    await (await returned).finished();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await page.getByRole('dialog', { name: 'Ready to review?' }).getByRole('link', { name: 'Fix: Add an affected room' }).click();
    await expect(page.getByLabel('New room name')).toHaveValue('');
  });

  test('Office notes typed and not saved ask before the way back to Finish', async ({ page }) => {
    const { company, jobId, finishPath, signIn } = await openJob(page);
    await page.goto(`/sign-in/${company.address}`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Sign in to ${company.name}` })).toBeVisible();
    await signIn('owner');
    const answered = checked(page, jobId, finishPath);
    await page.goto(finishPath);
    await (await answered).finished();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await page.getByRole('dialog', { name: 'Ready to review?' }).getByRole('link', { name: 'Fix: Add the year built' }).click();
    const choice = page.getByRole('button', { name: 'Online only', exact: true });
    const heading = page.getByRole('heading', { name: 'Check Scope', exact: true });
    await expect(heading.or(choice)).toBeAttached();
    if (await choice.isVisible()) await choice.click();
    await page.getByRole('link', { name: 'Job coordination' }).click();
    const notes = page.getByRole('textbox', { name: 'Office notes', exact: true });
    await expect(notes).toBeEditable();
    await notes.fill('Call the adjuster');
    await page.getByRole('link', { name: 'Back to Finish and review' }).click();
    const warning = page.getByRole('alert').filter({ hasText: 'Some changes are not saved' });
    await expect(warning).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(`${finishPath}$`));
    await warning.getByRole('button', { name: 'Keep editing' }).click();
    await expect(notes).toHaveValue('Call the adjuster');
  });

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
