import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ME_DB, ME_DB_VERSION, ME_STORE } from '../../src/lib/field/ds-me';
import { PASSWORD, readSeed, type ProjectSeed } from './sign-in/seed';

// The field shell's own screens (S6-2) in Chromium and WebKit at phone width: it starts from the
// sign-in the phone saved, the install sheet, and the banner for a phone that keeps nothing. How the
// worker keeps the shell and what it does with no signal is in offline/shell-worker.spec.ts.

const A = 'Company A Restoration';

test.use({ viewport: { width: 390, height: 844 } });

let mine: ProjectSeed;
test.beforeEach(({}, testInfo) => {
  mine = readSeed().projects[testInfo.project.name]!;
});

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('a phone that never signed in is asked to sign in, with a way to get there', async ({ page }) => {
  await page.goto('/sign-in/company-a');
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await page.goto('/field');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/sign-in/company-a');
});

test('the shell starts from the sign-in the phone saved, and signing out removes it', async ({ page }) => {
  await page.goto('/sign-in/company-a');
  await page.getByLabel('Email').fill(mine.memberA.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();

  await page.getByRole('link', { name: 'Open the field app' }).click();
  await expect(page).toHaveURL(/\/field$/);
  await expect(page.getByRole('heading', { name: A })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await expectAccessible(page);

  await page.goBack();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await page.goto('/field');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
});

// The rows of ds-me as they are now, read past the hold below.
function savedRows(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    ([db, store, version]) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const open = (window as unknown as { openUnheld: IDBFactory['open'] }).openUnheld(db as string, version as number);
        open.onupgradeneeded = () => open.result.createObjectStore(store as string, { keyPath: 'key' });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const rows = open.result.transaction(store as string, 'readonly').objectStore(store as string).getAll();
          rows.onsuccess = () => {
            open.result.close();
            resolve(rows.result as Record<string, unknown>[]);
          };
          rows.onerror = () => reject(rows.error);
        };
      }),
    [ME_DB, ME_STORE, ME_DB_VERSION] as const,
  );
}

test('the sign-in is saved before the field app is offered, and removed before signing out shows', async ({ page }) => {
  // A slow phone: the page's own ds-me opens answer a second late.
  await page.addInitScript((db) => {
    const open = IDBFactory.prototype.open;
    (window as unknown as { openUnheld: IDBFactory['open'] }).openUnheld = (name, version) => open.call(indexedDB, name, version);
    IDBFactory.prototype.open = function (name: string, version?: number) {
      const request = open.call(this, name, version);
      if (name !== db) return request;
      let handler: ((this: IDBRequest, event: Event) => unknown) | null = null;
      Object.defineProperty(request, 'onsuccess', {
        get: () => handler,
        set: (value: typeof handler) => {
          handler = value;
          request.addEventListener('success', (event) => setTimeout(() => handler?.call(request, event), 1_000));
        },
      });
      return request;
    };
  }, ME_DB);

  await page.goto('/sign-in/company-a');
  await page.getByLabel('Email').fill(mine.memberA.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open the field app' })).toBeVisible();

  const rows = await savedRows(page);
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0]!).sort()).toEqual(['address', 'companyName', 'config', 'key', 'savedAt', 'tenantId', 'uid']);
  expect(rows[0]).toMatchObject({ companyName: A, address: 'company-a' });
  expect(JSON.stringify(rows[0])).not.toContain(mine.memberA.email);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  expect(await savedRows(page)).toEqual([]);
});

test('the install sheet opens once with the Share-menu steps and its help line, then from its button', async ({ page }) => {
  await page.goto('/field');
  const sheet = page.getByRole('dialog', { name: 'Install to your Home Screen' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Tap the Share button')).toBeVisible();
  await expect(sheet.getByText('Scroll down and tap Add to Home Screen.')).toBeVisible();
  await expect(sheet.getByText('installing later starts empty and signed out')).toBeVisible();
  await expectAccessible(page);
  await sheet.getByRole('button', { name: 'Got it' }).click();
  await expect(sheet).toBeHidden();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: 'Install to your Home Screen' }).click();
  await expect(sheet).toBeVisible();
});

test('a phone that keeps no data says it is not saved', async ({ page }) => {
  await page.addInitScript(() => {
    // Private Browsing and a blocked store: opening a database throws.
    IDBFactory.prototype.open = () => {
      throw new DOMException('Storage refused', 'SecurityError');
    };
  });
  await page.goto('/field');
  const banner = page.getByRole('alert').filter({ hasText: 'Not saved on this phone' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('work can be lost when you close the page');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
});
