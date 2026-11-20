import { test as base, expect as baseExpect, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { expectNoAxeViolations } from './a11y';
import { readSeed, type TeamAccount, type TeamSeed } from './sign-in/seed';
import { record, estimateOfSnapshot, estimateFor, playApi, expectNoSideways, signInTo as signInToTeam, type Job, type Answers } from './review-fixtures';

// Review before signing, the owner's Reprice banner (S5b-6), in Chromium and WebKit at phone width. It signs in to the Auth
// emulator's tenant of the browser project's own company, as a phone does. The estimate routes need
// Postgres, which this test server does not run, so the job and estimate answers are played here at
// the network boundary (tests/db/estimate-api.test.ts holds the real routes). The estimate played is
// a real one: the engine prices a submitted record and the server's own view of it is what the page
// gets, so every amount and sentence on screen is the engine's.

const test = base;
test.use({ viewport: { width: 390, height: 844 } });
const expect = baseExpect.configure({ timeout: 20_000 });

let team: TeamSeed;
test.beforeEach(({}, testInfo) => {
  team = readSeed().teams[testInfo.project.name]!;
});

const signInTo = (page: Page, who: Pick<TeamAccount, 'email'>) => signInToTeam(page, team, who);

// The Reprice route, after playApi: GET is the preview until a POST is answered, then nothing to reprice; `post` decides that answer.
async function playReprice(page: Page, job: Job, preview: unknown, post: (request: Request) => [number, unknown]) {
  let moved = false;
  await page.route(`**/api/jobs/${job.id}/reprice`, (route: Route, request: Request) => {
    if (request.method() === 'GET') return route.fulfill({ json: moved ? { job: { revision: job.revision }, reprice: null } : preview });
    moved = true;
    const [status, json] = post(request);
    return route.fulfill({ status, json });
  });
}

// The server's Reprice preview at job revision 3: version 1 at $240.00, the newest, version 2, at $360.00.
const previewAt = () => ({
  job: { revision: 3 },
  reprice: { pinned: { version: 1, price: '$240.00', refused: null }, newest: { versionId: randomUUID(), version: 2, price: '$360.00', refused: null } },
});

test('the owner reads the before/after preview in a dialog, cancels, then confirms the reprice; nothing can be signed until scope is confirmed again and the revised estimate is made', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  const first = estimateFor(team, job.id, job.currentDraftId, 'owner');
  // The revised estimate is a new record on the new draft (a fresh Finish), headed "Revised {date}".
  const finishedDraftId = randomUUID();
  // On prices version 2 (pin 2, $3.00 a square foot) and the job revision the fresh Finish leaves.
  const revised = estimateOfSnapshot(team, record(job.id, finishedDraftId), 'owner', null, { letter: false }, 'Revised November 19, 2026: was $240.00', {
    versionSequence: 2,
    pinSequence: 2,
    unitPrice: '3.00',
    jobRevision: 5,
  });
  expect([revised.proposalSha256, revised.submissionId]).not.toEqual([first.proposalSha256, first.submissionId]);
  let finished = false;
  const answers: Answers = { estimate: first, make: () => (finished ? [201, { job, estimate: revised }] : [409, { error: 'scope_not_confirmed' }]) };
  await playApi(page, job, answers);
  const preview = previewAt();
  const sentReprice: unknown[] = [];
  await playReprice(page, job, preview, (request) => {
    sentReprice.push(request.postDataJSON());
    job.revision = 4;
    answers.estimate = null;
    return [200, { job: { ...job }, pin: { sequence: 2, version: 2 } }];
  });
  await signInTo(page, team.owner);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');

  const banner = main.getByRole('region', { name: 'Newer prices are published' });
  await expect(banner).toBeVisible();
  await expect(banner.getByText('This job is priced from prices version 1.', { exact: false })).toBeVisible();
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  // Cancel sends nothing.
  await banner.getByRole('button', { name: 'Review and reprice' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reprice this draft?' });
  await expect(dialog.getByText('Last submitted scope at prices version 1: $240.00')).toBeVisible();
  await expect(dialog.getByText('Last submitted scope at prices version 2: $360.00')).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(sentReprice).toEqual([]);
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toBeVisible();

  // Only the dialog's confirmation sends it.
  await banner.getByRole('button', { name: 'Review and reprice' }).click();
  await dialog.getByRole('button', { name: 'Reprice this draft' }).click();

  // The old estimate, its proposal and its signing actions are gone until the job is priced again.
  await expect(main.getByRole('heading', { name: 'Price this job' })).toBeVisible();
  expect(sentReprice).toEqual([{ revision: 3, changeId: expect.any(String), versionId: preview.reprice.newest.versionId }]);
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toHaveCount(0);
  await expect(main.getByText('Proposal', { exact: true })).toHaveCount(0);
  await expect(main.getByRole('checkbox', { name: /I reviewed the proposal/ })).toHaveCount(0);
  await expect(main.getByRole('region', { name: 'Newer prices are published' })).toHaveCount(0);

  // Pricing again at once is refused: the scope must be confirmed again on a new draft first.
  await main.getByRole('button', { name: 'Price this job' }).click();
  await expect(main.getByRole('alert').filter({ hasText: 'The scope was not confirmed' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toHaveCount(0);

  // After the fresh Finish the revised estimate is a new record and proposal, headed "Revised {date}".
  finished = true;
  job.currentDraftId = finishedDraftId;
  job.revision = 5;
  await main.getByRole('button', { name: 'Price this job' }).click();
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toBeVisible();
  await expect(main.getByRole('region', { name: 'Price' }).getByText('Price: $360.00', { exact: true })).toBeVisible();
  await main.getByText('Proposal', { exact: true }).click();
  await expect(main.getByText('Revised November 19, 2026: was $240.00')).toBeVisible();
});

test('pricing a job reads the Reprice preview again at the job revision the estimate was made at', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  const made = estimateFor(team, job.id, job.currentDraftId, 'owner');
  const answers: Answers = {
    estimate: null,
    make: () => {
      job.revision = 5;
      return [201, { job, estimate: made }];
    },
  };
  await playApi(page, job, answers);
  const asked: number[] = [];
  const newest = randomUUID();
  await page.route(`**/api/jobs/${job.id}/reprice`, (route: Route) => {
    asked.push(job.revision);
    return route.fulfill({
      json: { job: { revision: job.revision }, reprice: { pinned: { version: 1, price: '$240.00', refused: null }, newest: { versionId: newest, version: job.revision === 3 ? 2 : 3, price: '$360.00', refused: null } } },
    });
  });
  await signInTo(page, team.owner);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');
  await expect(main.getByText('You can reprice it with your newest prices, version 2.')).toBeVisible();
  await main.getByRole('button', { name: 'Price this job' }).click();
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toBeVisible();
  await expect(main.getByText('You can reprice it with your newest prices, version 3.')).toBeVisible();
  expect(asked).toEqual([3, 5]);
});

test('a reprice refused because the job moved on reloads the job instead of leaving a superseded estimate', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  const answers: Answers = { estimate: estimateFor(team, job.id, job.currentDraftId, 'owner') };
  await playApi(page, job, answers);
  await playReprice(page, job, previewAt(), () => {
    job.revision = 4;
    answers.estimate = null;
    return [409, { error: 'stale_revision' }];
  });
  await signInTo(page, team.owner);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Review and reprice' }).click();
  await page.getByRole('dialog', { name: 'Reprice this draft?' }).getByRole('button', { name: 'Reprice this draft' }).click();
  await expect(main.getByRole('heading', { name: 'Price this job' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toHaveCount(0);
});

test('a job signed elsewhere while the owner has Review open is read again, not left with its old signing controls', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  const answers: Answers = { estimate: estimateFor(team, job.id, job.currentDraftId, 'owner') };
  const sent = await playApi(page, job, answers);
  await playReprice(page, job, previewAt(), () => {
    job.status = 'signed';
    job.revision = 4;
    return [409, { error: 'job_signed' }];
  });
  await signInTo(page, team.owner);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Review and reprice' }).click();
  await page.getByRole('dialog', { name: 'Reprice this draft?' }).getByRole('button', { name: 'Reprice this draft' }).click();
  await expect.poll(() => sent).toContain(`GET /api/jobs/${job.id}/agreements`);
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toHaveCount(0);
});

test('when the preview cannot be read, the owner is told, not left with a missing banner', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  await playApi(page, job, { estimate: estimateFor(team, job.id, job.currentDraftId, 'owner') });
  await page.route(`**/api/jobs/${job.id}/reprice`, (route: Route) => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
  await signInTo(page, team.owner);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'could not be checked' })).toBeVisible();
});

test('an estimator never sees the Reprice banner, and the screen does not ask for it', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  await playApi(page, job, { estimate: estimateFor(team, job.id, job.currentDraftId, 'estimator') });
  let asked = 0;
  await page.route(`**/api/jobs/${job.id}/reprice`, (route: Route) => {
    asked += 1;
    return route.fulfill({ status: 403, json: { error: 'not_allowed' } });
  });
  await signInTo(page, team.estimator);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  await expect(page.getByRole('main').getByRole('heading', { name: 'Review before signing' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('region', { name: 'Newer prices are published' })).toHaveCount(0);
  expect(asked).toBe(0);
});
