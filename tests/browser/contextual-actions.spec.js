const { test, expect } = require('@playwright/test');
const { saveDraft, checkScope } = require('./actions');

// Synthetic backend and emulated layouts; physical iPhone keyboard acceptance stays separate.
for (const width of [390, 1280]) {
  test.describe('contextual actions at ' + width, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block' });
    test.beforeEach(async ({ page }) => {
      await page.goto('/app');
      await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
      await expect(page.locator('#saveStatus')).toHaveText('Saved');
      await checkScope(page);
    });

    test('signing stays available across document tabs and the draft bar stays out of review and signed jobs', async ({
      page,
    }) => {
      await page.locator('#address').fill('Synthetic contextual actions property');
      await page.locator('#yearBuilt').fill('1998');
      await page.locator('[data-room-key="finished_sf"]').fill('80');
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(page.locator('#documents')).toBeVisible();
      await expect(page.locator('.draft-actions')).toBeHidden();
      for (const name of ['proposal', 'claim', 'defense', 'photos']) {
        await page.locator('[data-tab="' + name + '"]').click();
        await expect(page.locator('#signingArea')).toBeVisible();
        await page.locator('#documentsConfirmed').scrollIntoViewIfNeeded();
        await expect(page.locator('#documentsConfirmed')).toBeInViewport();
        await page.screenshot({ path: test.info().outputPath('signing-' + name + '.png') });
      }
      await page.locator('#documentsConfirmed').check();
      const canvas = page.locator('#signCanvas');
      await canvas.scrollIntoViewIfNeeded();
      const rect = await canvas.boundingBox();
      await page.mouse.move(rect.x + 30, rect.y + 40);
      await page.mouse.down();
      await page.mouse.move(rect.x + 110, rect.y + 100, { steps: 8 });
      await page.mouse.move(rect.x + 220, rect.y + 30, { steps: 8 });
      await page.mouse.up();
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#saveStatus')).toHaveText('Signed');
      for (const name of ['proposal', 'claim', 'defense', 'photos']) {
        await page.locator('[data-tab="' + name + '"]').click();
        await expect(page.locator('#savedSignature')).toBeVisible();
        await expect(page.locator('#signedEvidenceStatus')).toContainText('restored');
      }
      await page.locator('.task-nav [data-task="property"]').click();
      await expect(page.locator('.draft-actions')).toBeHidden();
    });

    test('walkthrough action reads observations before auditing and requires explicit scope confirmation', async ({
      page,
    }) => {
      await page.locator('.task-nav [data-task="walkthrough"]').click();
      await expect(page.locator('#finishAudit')).toHaveText('Finish & review');
      await page.locator('#panel-walkthrough > details:last-child summary').click();
      await page
        .locator('#technicianTranscript')
        .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
      await expect(page.locator('#finishAudit')).toHaveText('Fill scope from walkthrough');
      const requests = [];
      page.on('request', (request) => requests.push(new URL(request.url()).pathname));
      await page.locator('#finishAudit').click();
      await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
      expect(requests.some((url) => url.endsWith('/scope-suggestions'))).toBe(true);
      expect(requests).not.toContain('/api/audit');
      await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
      await expect(page.locator('#finishAudit')).toHaveText('Finish & review');
      await page.locator('.task-nav [data-task="review"]').click();
      await expect(page.locator('.draft-actions')).toBeHidden();
      await page.locator('.task-nav [data-task="property"]').click();
      await expect(page.locator('.draft-actions')).toBeVisible();
    });

    test('notes and active Live choose scope fill, confirmed scope chooses review, and manual save lives in Jobs', async ({
      page,
      context,
    }) => {
      await expect(page.locator('.draft-actions #saveDraft')).toHaveCount(0);
      await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall.');
      await saveDraft(page);
      await expect(page.locator('#saveStatus')).toHaveText('Saved');
      await page.locator('.task-nav [data-task="walkthrough"]').click();
      await expect(page.locator('#finishAudit')).toHaveText('Fill scope from walkthrough');
      await context.setOffline(true);
      await expect(page.locator('#finishAudit')).toBeDisabled();
      await context.setOffline(false);
      await expect(page.locator('#finishAudit')).toBeEnabled();
      await page.locator('.task-nav [data-task="property"]').click();
      await page.locator('#scopeConfirmed').check();
      await page.locator('.task-nav [data-task="walkthrough"]').click();
      await expect(page.locator('#finishAudit')).toHaveText('Finish & review');
      await page.locator('.task-nav [data-task="property"]').click();
      await page.locator('#technicianNotes').fill('');
      await page.locator('.task-nav [data-task="walkthrough"]').click();
      await expect(page.locator('#finishAudit')).toHaveText('Finish & review');
      // Media acquisition is covered by the Live suite; isolate its active-state routing here.
      expect(
        await page.evaluate(() => {
          state.media = {};
          renderControls();
          const label = $('finishAudit').textContent;
          state.media = null;
          renderControls();
          return label;
        }),
      ).toBe('Fill scope from walkthrough');
    });

    test('normal text and number focus never scrolls programmatically; validation still reveals its blocker', async ({
      page,
    }) => {
      await page.evaluate(() => {
        window.scrollCalls = [];
        const original = window.scrollBy.bind(window);
        window.scrollBy = (...args) => {
          window.scrollCalls.push(args);
          original(...args);
        };
      });
      for (const id of ['address', 'yearBuilt']) {
        await page.locator('#' + id).click();
        await page.evaluate(() => {
          window.visualViewport?.dispatchEvent(new Event('resize'));
          window.visualViewport?.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(180);
      }
      expect(await page.evaluate(() => window.scrollCalls.length)).toBe(0);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.locator('#finishAudit').click();
      await expect(page.locator('#address')).toBeFocused();
      await expect(page.locator('#validationFeedback')).toBeInViewport();
      expect(await page.evaluate(() => window.scrollCalls.length)).toBeGreaterThan(0);
    });
  });
}
