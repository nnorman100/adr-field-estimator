import { expect, test } from './fixture';
import { COMPANY, nudge, openControlled } from './shell';
import { expectReportOnly, observeCsp } from '../csp-observer';

test.use({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });

test('the cached field shell, offline reload and reconnect produce no CSP reports', async ({
  context,
  page,
  lane,
}) => {
  const observer = await observeCsp(context);
  await openControlled(page, lane);
  await expectReportOnly(page);
  lane.cut();
  const sent = lane.bytes('app');
  await page.reload();
  await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();
  await nudge(page);
  await expect(page.getByText('No signal: your work is saved on this phone')).toBeVisible();
  expect(lane.bytes('app')).toBe(sent);
  await observer.expectClean(page);
  lane.restore();
  await nudge(page);
  await expect(page.getByText('No signal: your work is saved on this phone')).toBeHidden();
  await page.goto(`${lane.appUrl}/field/jobs`);
  await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();
  await observer.expectClean(page);
});
