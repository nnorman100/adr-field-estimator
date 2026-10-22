const { saveDraft } = require('./actions');
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'worker-lifecycle-loads',
      String(Number(sessionStorage.getItem('worker-lifecycle-loads') || 0) + 1),
    );
    const serviceWorker = new EventTarget(),
      registration = new EventTarget();
    serviceWorker.controller = null;
    registration.waiting = null;
    registration.update = async () => {};
    serviceWorker.register = async () => registration;
    Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker });
    window.__installWorker = ({ existingController }) => {
      const worker = new EventTarget();
      worker.state = 'installing';
      worker.postMessage = (message) => {
        if (message.type === 'SKIP_WAITING') {
          sessionStorage.setItem('worker-update-approved', 'yes');
          serviceWorker.controller = worker;
          worker.state = 'activated';
          serviceWorker.dispatchEvent(new Event('controllerchange'));
        }
      };
      serviceWorker.controller = existingController ? new EventTarget() : null;
      registration.installing = worker;
      registration.dispatchEvent(new Event('updatefound'));
      // WebKit can expose the first worker as controller before its installed callback.
      if (!existingController) serviceWorker.controller = worker;
      worker.state = 'installed';
      worker.dispatchEvent(new Event('statechange'));
      if (!existingController) {
        worker.state = 'activating';
        serviceWorker.dispatchEvent(new Event('controllerchange'));
      }
    };
  });
  await page.goto('/app');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.waitForFunction(() => state.session && !state.workspaceInitializing);
  await page.locator('.task-nav [data-task="property"]').click();
});

test('first worker claiming the page does not offer an update or reload the draft', async ({
  page,
}) => {
  await page.locator('#address').fill('First installation draft');
  await page.evaluate(() => window.__installWorker({ existingController: false }));
  await expect(page.locator('#updateBanner')).toBeHidden();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#address')).toHaveValue('First installation draft');
  expect(await page.evaluate(() => sessionStorage.getItem('worker-lifecycle-loads'))).toBe('1');
});

test('a replacement worker still waits for Save & update and restores the saved draft', async ({
  page,
}) => {
  await page.locator('#address').fill('Approved update draft');
  await page.evaluate(() => window.__installWorker({ existingController: true }));
  await expect(page.locator('#updateBanner')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('worker-lifecycle-loads'))).toBe('1');
  await page.locator('#applyUpdate').click();
  await page.waitForFunction(() => sessionStorage.getItem('worker-lifecycle-loads') === '2');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#address')).toHaveValue('Approved update draft');
  expect(await page.evaluate(() => sessionStorage.getItem('worker-update-approved'))).toBe('yes');
});
