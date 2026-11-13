// The Home Screen rule (owner decision G8, D-025; docs/plans/S6.md section 12), in Chromium and
// WebKit at phone width, with the network cut at the lane. On an iPhone, DryScope in a browser tab
// asks to be saved to the Home Screen and works online only; opened from the Home Screen icon it
// asks nothing; on Android and a computer it asks nothing and nothing is limited.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixture';
import { ONLINE_ONLY_TEXT, OFFLINE_TEXT } from '../../../src/app/field/banners';
import {
  HOME_SCREEN_HELP,
  HOME_SCREEN_NOTICE,
  HOME_SCREEN_STEPS,
  HOME_SCREEN_TITLE,
  HOME_SCREEN_WHY,
} from '../../../src/app/field/home-screen-text';
import { nudge, openControlled } from './shell';
import type { Page } from '@playwright/test';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const SHELL = '[data-shell="field"]';
const sheetOf = (page: Page) => page.getByRole('dialog', { name: HOME_SCREEN_TITLE });
const noticeButton = (page: Page) => page.getByRole('button', { name: HOME_SCREEN_TITLE });

test.use({ viewport: { width: 390, height: 844 } });

// Nothing on the page asks for anything: no sheet, no button, no notice, no online-only banner.
async function expectNoHomeScreenAsk(page: Page) {
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(noticeButton(page)).toHaveCount(0);
  await expect(page.getByText(HOME_SCREEN_NOTICE)).toHaveCount(0);
  await expect(page.getByText(ONLINE_ONLY_TEXT)).toHaveCount(0);
}

test.describe('an iPhone in a browser tab', () => {
  test.use({ userAgent: IPHONE, hasTouch: true });

  test('is asked once, in plain steps, to save DryScope to the Home Screen, and keeps working online', async ({
    context,
    lane,
  }) => {
    const page = await context.newPage();
    await openControlled(page, lane);
    await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'blocked');

    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(HOME_SCREEN_WHY)).toBeVisible();
    const steps = sheet.getByRole('listitem');
    await expect(steps).toHaveText([...HOME_SCREEN_STEPS]);
    await expect(sheet.getByText(HOME_SCREEN_HELP)).toBeVisible();
    // The steps name the controls as the phone shows them, in this order.
    await expect(steps.nth(0)).toContainText('Share button');
    await expect(steps.nth(0)).toContainText('square with an arrow pointing up');
    await expect(steps.nth(1)).toContainText('Add to Home Screen');
    await expect(steps.nth(2)).toHaveText('Tap Add.');
    await expect(steps.nth(3)).toContainText('from the new icon');
    // It is a website saved to the Home Screen, never an app to install from a store.
    const words = (await sheet.innerText()).toLowerCase();
    expect(words).not.toMatch(/install|app store|play store|download/);
    expect(words).toContain('with no signal');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await sheet.getByRole('button', { name: 'Got it' }).click();
    await expect(sheet).toBeHidden();
    // Online, the tab still works, and the ask stays on the page.
    await expect(page.getByRole('heading', { name: 'Shell Test Restoration' })).toBeVisible();
    await expect(page.getByText(HOME_SCREEN_NOTICE)).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Shell Test Restoration' })).toBeVisible();
    await expect(sheet).toBeHidden();
    await noticeButton(page).click();
    await expect(sheet).toBeVisible();
  });

  test('works online only: with no signal it says why and offline capture stays blocked', async ({
    context,
    lane,
  }) => {
    const page = await context.newPage();
    await openControlled(page, lane);
    await sheetOf(page).getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByText(ONLINE_ONLY_TEXT)).toBeHidden();

    lane.cut();
    await nudge(page);
    await expect(page.getByText(ONLINE_ONLY_TEXT)).toBeVisible();
    // The promise that work is kept on the phone is not made in a tab.
    await expect(page.getByText(OFFLINE_TEXT)).toHaveCount(0);
    await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'blocked');

    lane.restore();
    await nudge(page);
    await expect(page.getByText(ONLINE_ONLY_TEXT)).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Shell Test Restoration' })).toBeVisible();
  });
});

test.describe('an iPhone opened from the Home Screen icon', () => {
  test.use({ userAgent: IPHONE, hasTouch: true });

  test('is not asked, and offline capture is allowed (Safari standalone flag)', async ({
    context,
    lane,
  }) => {
    // What iOS sets for a Home Screen website.
    await context.addInitScript(() =>
      Object.defineProperty(navigator, 'standalone', { get: () => true }),
    );
    const page = await context.newPage();
    await openControlled(page, lane);
    await expectNoHomeScreenAsk(page);
    await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'allowed');

    lane.cut();
    await nudge(page);
    await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
    await expectNoHomeScreenAsk(page);
    await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'allowed');
  });

  test('is not asked when the display mode says standalone', async ({ context, lane }) => {
    await context.addInitScript(() => {
      const match = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => {
        if (query !== '(display-mode: standalone)') return match(query);
        // A list that says "standalone" and never changes.
        return {
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList;
      };
    });
    const page = await context.newPage();
    await openControlled(page, lane);
    await expectNoHomeScreenAsk(page);
    await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'allowed');
  });
});

test.describe('Android and a computer', () => {
  test.describe('Android', () => {
    test.use({ userAgent: ANDROID, hasTouch: true });

    test('are not asked and not limited, online or with no signal', async ({ context, lane }) => {
      const page = await context.newPage();
      await openControlled(page, lane);
      await expectNoHomeScreenAsk(page);
      await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'allowed');
      lane.cut();
      await nudge(page);
      await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
      await expectNoHomeScreenAsk(page);
      await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'allowed');
    });
  });

  test('a computer browser is not asked and not limited, online or with no signal', async ({
    context,
    lane,
  }) => {
    const page = await context.newPage();
    await openControlled(page, lane);
    await expectNoHomeScreenAsk(page);
    await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'allowed');
    lane.cut();
    await nudge(page);
    await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
    await expectNoHomeScreenAsk(page);
    await expect(page.locator(SHELL)).toHaveAttribute('data-offline-capture', 'allowed');
  });
});
