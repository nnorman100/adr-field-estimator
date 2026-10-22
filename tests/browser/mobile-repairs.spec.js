const { saveDraft, checkScope } = require('./actions');
const { test, expect } = require('@playwright/test');
const pageErrors = new WeakMap();

// Local synthetic backend only. These contexts emulate touch layout, not a physical iPhone.
async function task(page, name) {
  await page.locator('.task-nav [data-task="' + name + '"]').click();
}
function roomName(page, index) {
  return page.locator('[data-room-index="' + index + '"][data-room-key="name"]');
}
function lossPill(page, index, value) {
  return page.locator(
    '[data-room-index="' + index + '"][data-room-key="loss"][value="' + value + '"]',
  );
}
function removeButton(page, index) {
  return page
    .locator('#rooms .room')
    .nth(index)
    .getByRole('button', { name: /Remove/ });
}
async function fault(page, faults) {
  return page.evaluate(
    async (faults) =>
      (
        await fetch('/__test/fault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: sessionStorage.getItem('synthetic-uid'), faults }),
        })
      ).json(),
    faults,
  );
}
async function idle(page) {
  // Wait beyond both existing debounce windows, then await the actual sync queue.
  await page.waitForTimeout(1900);
  await page.evaluate(async () => {
    await syncChain.catch(() => {});
  });
  await expect.poll(() => page.evaluate(() => state.syncing)).toBe(false);
}
async function scope(page, names = ['Kitchen']) {
  await task(page, 'property');
  await page.locator('#address').fill('Synthetic mobile repair property');
  await page.locator('#yearBuilt').fill('1960');
  await roomName(page, 0).fill(names[0]);
  await page.locator('[data-room-index="0"][data-room-key="finished_sf"]').fill('10');
  for (let i = 1; i < names.length; i++) {
    await page.locator('#addRoom').click();
    await roomName(page, i).fill(names[i]);
  }
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function audit(page, names) {
  await scope(page, names);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
}
async function draw(page) {
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 40);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.45, rect.y + 90, { steps: 8 });
  await page.mouse.move(rect.x + rect.width * 0.8, rect.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => !!state.signature)).toBe(true);
}
async function snapshot(page) {
  return page.evaluate(async () => ({
    draft: structuredClone(state.draft),
    data: structuredClone(state.draft.data),
    signature: state.signature,
    pendingAuthorization: structuredClone(state.pendingAuthorization),
    documents: structuredClone(state.documents),
    record: structuredClone(state.record),
    scopeConfirmed: state.draft.data.scope_confirmed,
    confirmation: $('documentsConfirmed').checked,
    localVersion: state.localVersion,
    confirmedAuthorization,
    persisted: await dbAction('readonly', (store) =>
      store.get(draftKey(state.draft.inspection_id)),
    ),
  }));
}
async function clearOfChrome(page, selector) {
  await expect
    .poll(
      () =>
        page.locator(selector).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const obstacles = ['.product-bar', '.masthead', '.inspection-shell', '.draft-actions']
            .map((s) => document.querySelector(s))
            .filter(
              (node) =>
                node &&
                getComputedStyle(node).display !== 'none' &&
                getComputedStyle(node).visibility !== 'hidden',
            )
            .filter((node) => ['sticky', 'fixed'].includes(getComputedStyle(node).position))
            .map((node) => node.getBoundingClientRect());
          const inside =
            r.width > 0 &&
            r.height > 0 &&
            r.left >= 0 &&
            r.top >= 0 &&
            r.right <= innerWidth &&
            r.bottom <= innerHeight;
          const overlap = obstacles.some(
            (o) => r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top,
          );
          // Sample inside rounded borders, while the entire rect still must clear overlays.
          const inset = Math.min(6, r.width / 4, r.height / 4);
          const points = [
            [r.left + inset, r.top + inset],
            [r.right - inset, r.top + inset],
            [r.left + inset, r.bottom - inset],
            [r.right - inset, r.bottom - inset],
          ];
          const hit = points.every(([x, y]) => {
            const top = document.elementFromPoint(x, y);
            return top === el || el.contains(top);
          });
          return { inside, overlap, hit };
        }),
      { message: selector + ' must be fully visible and hit-testable beyond sticky chrome' },
    )
    .toEqual({ inside: true, overlap: false, hit: true });
}
async function feedback(page, selector) {
  const fallback = page.locator('#validationFeedback');
  if (await fallback.count()) {
    await expect(fallback).toBeVisible();
    await expect(fallback).not.toHaveText('');
    await clearOfChrome(page, '#validationFeedback');
  } else {
    // Native reportValidity() is valid feedback when no inline fallback exists.
    expect(
      await page.locator(selector).evaluate((el) => !el.validity.valid && !!el.validationMessage),
    ).toBe(true);
  }
}
async function capture(page, name) {
  await page.screenshot({ path: test.info().outputPath(name), fullPage: true });
  await page.screenshot({ path: test.info().outputPath('viewport-' + name) });
}
async function longShell(page) {
  await page.evaluate(() => {
    $('jobTitle').textContent =
      'Synthetic property with a deliberately long building, unit, floor and street description for mobile wrapping';
    $('saveStatus').textContent =
      'Private inspection saved on this device; reconnect before generating documents and completing the homeowner review.';
  });
}

for (const width of [320, 390])
  test.describe('mobile repairs at ' + width + '×844', () => {
    // Service-worker/offline lifecycle remains covered by the separate existing browser suites.
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width, height: 844 },
      serviceWorkers: 'block',
    });
    test.beforeEach(async ({ page }) => {
      const errors = [];
      pageErrors.set(page, errors);
      page.on('pageerror', (error) => errors.push(error.stack || error.message));
      await page.goto('/app');
      await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
      await expect(page.locator('#saveStatus')).toHaveText('Saved');
      await checkScope(page);
    });
    test.afterEach(async ({ page }) => {
      expect(pageErrors.get(page) || [], 'No uncaught browser exceptions').toEqual([]);
    });

    test('primary actions are navy and success messages are navy on paper with a check, never green', async ({
      page,
    }) => {
      const navy = 'rgb(11, 37, 69)';
      const primary = page.locator('#startWalk');
      await expect(primary).toHaveCSS('background-color', navy);
      await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)');
      await saveDraft(page);
      const message = page.locator('#message');
      await expect(message).toHaveText('Draft saved privately.');
      await expect(message).toHaveClass('message success');
      await expect(message).toHaveCSS('color', navy);
      await expect(message).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(message).toHaveCSS('border-left-color', navy);
      expect(await message.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"✓ "');
    });

    test('room removal opens a named safe-default modal; cancel and Escape preserve memory and IndexedDB', async ({
      page,
    }) => {
      await audit(page, ['Kitchen', 'Bathroom', 'Hall']);
      await page.locator('#documentsConfirmed').check();
      await draw(page);
      await fault(page, { authorize: 1 });
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#authorizationStatus')).toContainText('Save not confirmed');
      await task(page, 'property');
      await idle(page);
      const before = await snapshot(page);
      expect(before.pendingAuthorization).not.toBeNull();
      const trigger = removeButton(page, 1);
      await trigger.click();
      const dialog = page.locator('#removeRoomDialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-labelledby', 'removeRoomTitle');
      await expect(dialog).toHaveAttribute('aria-describedby', 'removeRoomDescription');
      await expect(page.locator('#removeRoomTitle')).not.toHaveText('');
      await expect(page.locator('#removeRoomDescription')).toContainText('Bathroom');
      await expect(page.locator('#cancelRoomRemoval')).toBeFocused();
      await expect
        .poll(() =>
          page.evaluate(
            () => $('removeRoomDialog').open && $('removeRoomDialog').matches(':modal'),
          ),
        )
        .toBe(true);
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#confirmRoomRemoval')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#cancelRoomRemoval')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#confirmRoomRemoval')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#cancelRoomRemoval')).toBeFocused();
      await capture(page, 'room-removal-safe-default.png');
      await page.locator('#cancelRoomRemoval').click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await idle(page);
      expect(await snapshot(page)).toEqual(before);
      await trigger.click();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await idle(page);
      expect(await snapshot(page)).toEqual(before);
    });

    test('confirmed removal deletes only the selected room and invalidates dependent signing state', async ({
      page,
    }) => {
      await audit(page, ['Kitchen', 'Bathroom', 'Hall']);
      await page.locator('#documentsConfirmed').check();
      await draw(page);
      await fault(page, { authorize: 1 });
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#authorizationStatus')).toContainText('Save not confirmed');
      await task(page, 'property');
      await idle(page);
      const before = await snapshot(page);
      await removeButton(page, 1).click();
      await page.locator('#confirmRoomRemoval').click();
      await expect(page.locator('#removeRoomDialog')).toBeHidden();
      await expect(roomName(page, 1)).toBeFocused();
      await expect(roomName(page, 1)).toHaveValue('Hall');
      const after = await snapshot(page);
      expect(after.data).toEqual({
        ...before.data,
        rooms: [before.data.rooms[0], before.data.rooms[2]],
        scope_confirmed: false,
      });
      expect(after.draft.photos).toEqual(before.draft.photos);
      expect(after.localVersion).toBe(before.localVersion + 1);
      expect(after.signature).toBeNull();
      expect(after.pendingAuthorization).toBeNull();
      expect(after.documents).toBeNull();
      expect(after.confirmation).toBe(false);
      expect(after.confirmedAuthorization).toBeNull();
      await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
      await expect(page.locator('#documents')).toBeHidden();
      await idle(page);
      const persisted = await snapshot(page);
      expect(persisted.persisted.draft.data).toEqual(after.data);
      await removeButton(page, 1).click();
      await page.locator('#confirmRoomRemoval').click();
      await expect(roomName(page, 0)).toBeFocused();
      await removeButton(page, 0).click();
      await page.locator('#confirmRoomRemoval').click();
      await expect(page.locator('#rooms .room')).toHaveCount(0);
      await expect(page.locator('#addRoom')).toBeFocused();
    });

    test('signature and document errors stay local, associated and clear only when corrected', async ({
      page,
    }) => {
      await audit(page);
      const signingRequests = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/authorize')) signingRequests.push(request);
      });
      await page.locator('#documentsConfirmed').check();
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#signatureError')).toBeVisible();
      await expect(page.locator('#signatureError')).toContainText(/signature/i);
      await expect(page.locator('#clearSignature')).toBeFocused();
      await expect(page.locator('#signCanvas')).toHaveAttribute('aria-invalid', 'true');
      for (const id of ['signCanvas', 'clearSignature'])
        await expect(page.locator('#' + id)).toHaveAttribute(
          'aria-describedby',
          /\bsignatureError\b/,
        );
      await clearOfChrome(page, '#clearSignature');
      await clearOfChrome(page, '#signatureError');
      expect(
        await page.locator('#signatureError').evaluate((el) => {
          const e = el.getBoundingClientRect(),
            c = $('signCanvas').getBoundingClientRect();
          return Math.max(0, e.top - c.bottom, c.top - e.bottom);
        }),
      ).toBeLessThanOrEqual(24);
      await capture(page, 'signature-local-error.png');
      expect(signingRequests).toHaveLength(0);
      await draw(page);
      await expect(page.locator('#signatureError')).toBeHidden();
      await expect(page.locator('#signCanvas')).not.toHaveAttribute('aria-invalid', 'true');
      await page.locator('#documentsConfirmed').uncheck();
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#documentsConfirmed')).toBeFocused();
      await expect(page.locator('#documentsConfirmed')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#documentsConfirmed')).toHaveAttribute(
        'aria-describedby',
        /\bdocumentsConfirmedError\b/,
      );
      await expect(page.locator('#documentsConfirmedError')).toBeVisible();
      expect(
        await page.locator('#documentsConfirmedError').evaluate((el) => {
          const label = $('documentsConfirmed').closest('label');
          return label.nextElementSibling === el;
        }),
      ).toBe(true);
      await clearOfChrome(page, '#documentsConfirmed');
      await clearOfChrome(page, '#documentsConfirmedError');
      await expect(page.locator('#authorizationStatus')).toHaveText('');
      await expect(page.locator('#authorizationStatus')).not.toContainText(
        /draw a signature|proposal was reviewed/i,
      );
      expect(signingRequests).toHaveLength(0);
      await page.locator('#clearSignature').click();
      expect(await page.evaluate(() => state.signature)).toBeNull();
      await expect(page.locator('#documentsConfirmedError')).toBeVisible();
      await expect(page.locator('#documentsConfirmed')).toHaveAttribute('aria-invalid', 'true');
      await draw(page);
      await expect(page.locator('#documentsConfirmedError')).toBeVisible();
      await expect(page.locator('#documentsConfirmed')).toHaveAttribute('aria-invalid', 'true');
      const signature = await page.evaluate(() => state.signature);
      await page.locator('#documentsConfirmed').check();
      await expect(page.locator('#documentsConfirmedError')).toBeHidden();
      await expect(page.locator('#documentsConfirmed')).not.toHaveAttribute('aria-invalid', 'true');
      expect(await page.evaluate(() => state.signature)).toBe(signature);
    });

    test('authorization retry retains its reference and signed restoration disables every room removal', async ({
      page,
    }) => {
      await audit(page, ['Kitchen', 'Bathroom']);
      await page.locator('#documentsConfirmed').check();
      await draw(page);
      await fault(page, { authorize: 1 });
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#authorizationStatus')).toContainText('Save not confirmed');
      await clearOfChrome(page, '#authorizationStatus');
      const pending = await page.evaluate(() => structuredClone(state.pendingAuthorization));
      expect(pending.auth_id).toMatch(/^ADR-AUTH-/);
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#saveStatus')).toHaveText('Signed');
      await expect(page.locator('#savedSignature')).toBeVisible();
      const { references } = await fault(page, {});
      expect(references).toEqual([pending.auth_id, pending.auth_id]);
      await page.reload();
      await expect(page.locator('#address')).toBeEnabled();
      await expect(page.locator('#saveStatus')).toHaveText('Saved');
      await task(page, 'property');
      await page.locator('#jobMenu > summary').click();
      await page.locator('#openJobs').click();
      await page.locator('.job-link').filter({ hasText: 'Signed ·' }).click();
      await expect(page.locator('#savedSignature')).toBeVisible();
      await expect
        .poll(() =>
          page.locator('#savedSignature').evaluate((img) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
      expect(await page.evaluate(() => state.signed.auth_id)).toBe(pending.auth_id);
      await task(page, 'property');
      await expect(page.locator('#address')).toBeDisabled();
      await expect(page.locator('#rooms .room')).toHaveCount(2);
      await expect(removeButton(page, 0)).toBeDisabled();
      await expect(removeButton(page, 1)).toBeDisabled();
      await expect(page.locator('#removeRoomDialog')).toBeHidden();
    });

    for (const field of ['second room', 'year', 'address', 'scope'])
      test(
        'repeated missing ' + field + ' validation focuses the full unobscured field',
        async ({ page }) => {
          await scope(page, ['Kitchen', 'Bathroom']);
          const selector =
            field === 'second room'
              ? '[data-room-index="1"][data-room-key="name"]'
              : field === 'year'
                ? '#yearBuilt'
                : field === 'address'
                  ? '#address'
                  : '#scopeConfirmed';
          if (field === 'scope') await page.locator(selector).uncheck();
          else {
            await page.locator(selector).fill('');
            await page.locator('#scopeConfirmed').check();
          }
          const auditRequests = [];
          page.on('request', (request) => {
            if (request.url().endsWith('/api/audit')) auditRequests.push(request);
          });
          // Twice from Walk & Photo: the second attempt must re-focus the same field.
          for (let attempt = 0; attempt < 2; attempt++) {
            await task(page, 'walkthrough');
            await page.locator('#finishAudit').click();
            await expect(page.locator('#panel-property')).toBeVisible();
            await expect(page.locator(selector)).toBeFocused();
            await clearOfChrome(page, selector);
            if (field === 'scope') {
              const fallback = (await page.locator('#validationFeedback').count())
                ? '#validationFeedback'
                : '#message';
              await expect(page.locator(fallback)).toBeVisible();
              await expect(page.locator(fallback)).toContainText(/confirm|scope/i);
              await clearOfChrome(page, fallback);
            } else await feedback(page, selector);
            expect(auditRequests).toHaveLength(0);
          }
          await capture(page, 'validation-' + field.replaceAll(' ', '-') + '.png');
        },
      );

    test('long heading and save status and viewport resize do not hide validation', async ({
      page,
    }) => {
      await scope(page, ['Kitchen', 'Bathroom']);
      await roomName(page, 1).fill('');
      await page.locator('#scopeConfirmed').check();
      await idle(page);
      await longShell(page);
      for (const nextWidth of [width, width === 320 ? 390 : 320]) {
        await page.setViewportSize({ width: nextWidth, height: 844 });
        await task(page, 'walkthrough');
        await page.locator('#finishAudit').click();
        await expect(roomName(page, 1)).toBeFocused();
        await clearOfChrome(page, '[data-room-index="1"][data-room-key="name"]');
        await feedback(page, '[data-room-index="1"][data-room-key="name"]');
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
        // The one-row phone header truncates a long title and status instead of wrapping them.
        for (const id of ['#jobTitle', '#saveStatus'])
          expect(
            await page
              .locator(id)
              .evaluate(
                (el) =>
                  el.getBoundingClientRect().height <=
                    Math.ceil(parseFloat(getComputedStyle(el).lineHeight)) &&
                  el.scrollWidth > el.clientWidth,
              ),
          ).toBe(true);
      }
      await capture(page, 'long-shell-validation.png');
    });

    test('save-status changes never resize the sticky shell, and a later good save clears a rejected save', async ({
      page,
    }) => {
      // The page bounced after a Live walkthrough: each save state swapped a one-line status for
      // a two-line one, resizing the sticky shell and moving everything below it.
      await page.route('**/api/inspections/*', async (route) => {
        // Hold each save long enough for "Saving…" to render.
        if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 600));
        await route.continue();
      });
      await page.evaluate(() => {
        window.shellHeights = new Set();
        window.statuses = new Set();
        const shell = document.querySelector('.inspection-shell');
        new ResizeObserver(() =>
          window.shellHeights.add(Math.round(shell.getBoundingClientRect().height)),
        ).observe(shell);
        new MutationObserver(() => window.statuses.add($('saveStatus').textContent)).observe(
          $('saveStatus'),
          { childList: true, characterData: true, subtree: true },
        );
      });
      // An emptied required count is rejected by the server (422).
      await page.locator('#dryingDays').fill('');
      await expect(page.locator('#message')).toHaveText('Input should be a valid integer');
      await expect(page.locator('#saveStatus')).toHaveText('Saved on phone · sync pending');
      await page.locator('#dryingDays').fill('3');
      await expect(page.locator('#saveStatus')).toHaveText('Saved');
      await expect(page.locator('#message')).toBeHidden();
      const seen = await page.evaluate(() => [...window.statuses]);
      expect(seen).toEqual(
        expect.arrayContaining(['Saved on phone · sync pending', 'Saving…', 'Saved']),
      );
      expect(await page.evaluate(() => [...window.shellHeights])).toHaveLength(1);
    });

    test('short viewport keeps invalid room and feedback usable with a fixed footer, then restores sticky shell', async ({
      page,
    }) => {
      await scope(page, ['Kitchen', 'Bathroom']);
      await roomName(page, 1).fill('');
      await page.locator('#scopeConfirmed').check();
      await idle(page);
      await longShell(page);
      const selector = '[data-room-index="1"][data-room-key="name"]';
      await page.setViewportSize({ width, height: 450 });
      await task(page, 'walkthrough');
      await page.locator('#finishAudit').click();
      await expect(roomName(page, 1)).toBeFocused();
      await clearOfChrome(page, selector);
      await feedback(page, selector);
      await expect
        .poll(() =>
          page.locator('.draft-actions').evaluate((el) => {
            const r = el.getBoundingClientRect();
            return {
              fixed: getComputedStyle(el).position === 'fixed',
              visible: r.top >= 0 && r.bottom <= innerHeight && r.width > 0 && r.height > 0,
            };
          }),
        )
        .toEqual({ fixed: true, visible: true });
      await expect
        .poll(() =>
          page.locator('#finishAudit').evaluate((el) => {
            const r = el.getBoundingClientRect(),
              hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return r.top >= 0 && r.bottom <= innerHeight && (hit === el || el.contains(hit));
          }),
        )
        .toBe(true);
      await capture(page, 'short-viewport-validation.png');
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(() =>
          page.locator('.inspection-shell').evaluate((el) => getComputedStyle(el).position),
        )
        .toBe('sticky');
      await task(page, 'walkthrough');
      await page.locator('#finishAudit').click();
      await expect(roomName(page, 1)).toBeFocused();
      await clearOfChrome(page, selector);
      await feedback(page, selector);
      await capture(page, 'restored-height-validation.png');
    });

    test('clearing displayed inspection closes removal modal, erases its room text and releases body interaction', async ({
      page,
    }) => {
      await scope(page, ['Kitchen', 'Private bathroom']);
      await idle(page);
      await removeButton(page, 1).click();
      await expect(page.locator('#removeRoomDialog')).toBeVisible();
      await expect(page.locator('#removeRoomDescription')).toContainText('Private bathroom');
      // This is the cleanup seam used on access changes; no shared workspace fixtures are mutated.
      await page.evaluate(() => clearDisplayedInspection());
      await expect(page.locator('#removeRoomDialog')).toBeHidden();
      await expect(page.locator('#removeRoomDescription')).toHaveText('');
      await expect
        .poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length))
        .toBe(0);
      await expect(page.locator('#rooms .room')).toHaveCount(0);
      await task(page, 'walkthrough');
      await expect(page.locator('#panel-walkthrough')).toBeVisible();
      await expect(page.locator('.task-nav [data-task="walkthrough"]')).toHaveAttribute(
        'aria-current',
        'step',
      );
      expect(
        await page.evaluate(() => !$('removeRoomDialog').contains(document.activeElement)),
      ).toBe(true);
      await task(page, 'property');
      await page.evaluate(() => renderRooms());
      await page.evaluate(() => {
        const name = $('rooms').querySelector('[data-room-index="1"][data-room-key="name"]');
        name.value = '';
        showValidationFeedback(name);
      });
      await expect(page.locator('#validationFeedback')).toBeVisible();
      expect(
        await page.locator('#validationFeedback').evaluate((el) => !!el.closest('#rooms')),
      ).toBe(true);
      await page.evaluate(() => clearDisplayedInspection());
      await expect(page.locator('#validationFeedback')).toHaveCount(1);
      await expect(page.locator('#validationFeedback')).toBeHidden();
      expect(await page.locator('#validationFeedback').evaluate((el) => el.isConnected)).toBe(true);
      await expect(page.locator('#rooms .room')).toHaveCount(0);
      await page.evaluate(() => {
        renderRooms();
        fillForm();
      });
      await expect(page.locator('#rooms .room')).toHaveCount(2);
      await expect(roomName(page, 0)).toHaveValue('Kitchen');
      await expect(roomName(page, 1)).toHaveValue('Private bathroom');
      await expect(page.locator('#validationFeedback')).toHaveCount(1);
      await expect(page.locator('#validationFeedback')).toBeHidden();
      expect(pageErrors.get(page) || [], 'Validation singleton recovery must not throw').toEqual(
        [],
      );
    });

    test('validation opens the collapsed sheet-charges section to show an invalid charge', async ({
      page,
    }) => {
      await scope(page, ['Kitchen']);
      await expect(page.locator('details.sheet-charges')).not.toHaveAttribute('open', '');
      await page.evaluate(() => {
        const input = $('monitoringHours');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.locator('#finishAudit').click();
      await expect(page.locator('details.sheet-charges')).toHaveAttribute('open', '');
      await expect(page.locator('#monitoringHours')).toBeFocused();
      await expect(page.locator('#validationFeedback')).toBeVisible();
    });

    test('a background draft change does not cancel a confirmed room removal', async ({ page }) => {
      await scope(page, ['Kitchen', 'Bathroom']);
      await idle(page);
      await removeButton(page, 1).click();
      await expect(page.locator('#removeRoomDialog')).toBeVisible();
      // A finished Live transcript fragment calls changed() while the dialog is open.
      await page.evaluate(() => changed());
      await page.locator('#confirmRoomRemoval').click();
      await expect(page.locator('#removeRoomDialog')).toBeHidden();
      await expect(page.locator('#rooms .room')).toHaveCount(1);
      await expect(roomName(page, 0)).toHaveValue('Kitchen');
    });

    // The word is what the test asserts; the tint and pill colour only repeat it.
    test('room cards and the review say WATER, MOLD or both from one-tap pills that keep the category in step', async ({
      page,
    }) => {
      await scope(page, ['Kitchen', 'Bathroom']);
      const cards = page.locator('#rooms .room'),
        category = page.locator('[data-room-index="1"][data-room-key="category"]');
      await expect(cards.locator('.loss-tag')).toHaveText(['WATER · Cat 1', 'WATER · Cat 1']);
      await expect(lossPill(page, 1, 'water')).toBeChecked();
      // A category-3 black-water room without mold stays a water loss; the label is explicit.
      await category.selectOption('3');
      await expect(cards.nth(1).locator('.loss-tag')).toHaveText(['WATER · Cat 3']);
      await expect(cards.nth(1)).toHaveAttribute('data-loss', 'water');
      await expect(lossPill(page, 1, 'water')).toBeChecked();
      // Mold prices at the sheet's category 3 / mold rates, so the Mold pill moves the select too.
      await category.selectOption('2');
      await lossPill(page, 1, 'mold').check();
      await expect(category).toHaveValue('3');
      await expect(cards.nth(1).locator('.loss-tag')).toHaveText(['MOLD · Cat 3']);
      await expect(cards.nth(1)).toHaveAttribute('data-loss', 'mold');
      await expect(cards.nth(0)).toHaveAttribute('data-loss', 'water');
      // Water keeps whichever category the select shows; Water + Mold is category 3 again.
      await lossPill(page, 1, 'water').check();
      await expect(category).toHaveValue('3');
      await expect(cards.nth(1).locator('.loss-tag')).toHaveText(['WATER · Cat 3']);
      await category.selectOption('1');
      await lossPill(page, 1, 'both').check();
      await expect(category).toHaveValue('3');
      await expect(cards.nth(1).locator('.loss-tag')).toHaveText(['WATER · Cat 3', 'MOLD · Cat 3']);
      await expect(cards.nth(1)).toHaveAttribute('data-loss', 'both');
      // The room name and category select share a row above the pills; at 390 px the pills share one too.
      const [nameBox, categoryBox, ...pillBoxes] = await Promise.all(
        [
          roomName(page, 1),
          category,
          ...['water', 'mold', 'both'].map((v) => lossPill(page, 1, v)),
        ].map((control) => control.boundingBox()),
      );
      for (const box of pillBoxes) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.y).toBeGreaterThan(categoryBox.y + categoryBox.height - 1);
      }
      expect(Math.abs(categoryBox.y - nameBox.y)).toBeLessThan(2);
      if (width === 390)
        for (const box of pillBoxes) expect(Math.abs(box.y - pillBoxes[0].y)).toBeLessThan(2);
      expect(Math.abs(categoryBox.width - nameBox.width)).toBeLessThan(2);
      expect(await page.evaluate(() => state.draft.data.rooms[1].loss)).toBe('both');
      await page.locator('[data-room-index="1"][data-room-key="finished_sf"]').fill('10');
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(page.locator('#documents')).toBeVisible();
      await expect(page.locator('#reviewRooms .loss-tag')).toHaveText([
        'Kitchen · WATER · Cat 1',
        'Bathroom · WATER · Cat 3',
        'Bathroom · MOLD · Cat 3',
      ]);
      // The printed documents keep the category words; the label prices nothing and is not printed.
      const printed = await page.locator('#documents').evaluate((panel) => {
        const copy = panel.cloneNode(true);
        copy.querySelectorAll('.loss-chips').forEach((chips) => chips.remove());
        document.body.append(copy);
        const text = copy.innerText;
        copy.remove();
        return text;
      });
      expect(printed).toContain('Bathroom: category 3 finished/drywall/trim demolition');
      expect(printed).not.toMatch(/MOLD · Cat|WATER · Cat/);
      // With a job open the navy job bar is the only header row; Help sits in its More menu.
      expect((await page.locator('.jobbar').boundingBox()).height).toBeLessThan(85);
      await page.locator('#jobMenu > summary').click();
      await expect(page.locator('#jobMenu #helpButton')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    });

    test('rarely changed fields wait behind More drawers that validation and category 3 open', async ({
      page,
    }) => {
      await scope(page, ['Kitchen']);
      const card = page.locator('#rooms .room').first(),
        waste = page.locator('[data-room-index="0"][data-room-key="waste_percent"]'),
        cabinetry = page.locator('[data-room-index="0"][data-room-key="custom_cabinetry"]'),
        roomMore = card.locator('details.room-more'),
        equipmentMore = page.locator('details.more-equipment');
      // Waste % and, below category 3, cabinetry sit inside the room's drawer.
      await expect(waste).toBeHidden();
      await expect(cabinetry).toBeHidden();
      await expect(roomMore.locator('[data-room-key="custom_cabinetry"]')).toHaveCount(1);
      await roomMore.locator('summary').click();
      await expect(waste).toBeVisible();
      await expect(cabinetry).toBeVisible();
      await roomMore.locator('summary').click();
      // The Mold pill makes the room category 3, so cabinetry moves onto the card itself.
      await lossPill(page, 0, 'mold').check();
      await expect(cabinetry).toBeVisible();
      await expect(roomMore.locator('[data-room-key="custom_cabinetry"]')).toHaveCount(0);
      await cabinetry.check();
      await page.locator('[data-room-index="0"][data-room-key="category"]').selectOption('1');
      await expect(cabinetry).toBeHidden();
      expect(await page.evaluate(() => state.draft.data.rooms[0].custom_cabinetry)).toBe(true);
      // Wood-floor drying, added labor and after-hours wait behind More equipment & labor.
      for (const id of ['woodFloorSystems', 'woodFloorDays', 'laborHours', 'afterHours'])
        await expect(page.locator('#' + id)).toBeHidden();
      await expect(equipmentMore).not.toHaveAttribute('open', '');
      await equipmentMore.locator('summary').click();
      for (const id of ['woodFloorSystems', 'woodFloorDays', 'laborHours', 'afterHours'])
        await expect(page.locator('#' + id)).toBeVisible();
      // The job-charges summary names the sheet bundle until one of its five quantities changes.
      const summary = page.locator('details.sheet-charges summary');
      await expect(summary).toHaveText('Standard job charges · $1,180.20 at sheet quantities');
      await expect(page.locator('details.sheet-charges')).not.toHaveAttribute('open', '');
      await summary.click();
      await page.locator('#monitoringHours').fill('10');
      await expect(summary).toHaveText(
        "Standard job charges · adjusted from the sheet's $1,180.20",
      );
      await page.locator('#matterportScans').fill('1');
      await page.locator('#monitoringHours').fill('13.25');
      await expect(summary).toHaveText('Standard job charges · $1,180.20 at sheet quantities');
      await saveDraft(page);
      await idle(page);
      await page.reload();
      await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
      await checkScope(page);
      await expect(summary).toHaveText('Standard job charges · $1,180.20 at sheet quantities');
      await expect(page.locator('#matterportScans')).toHaveValue('1');
      // An invalid waste value opens the closed room drawer and focuses the field.
      await page.evaluate(() => {
        const input = document.querySelector(
          '[data-room-index="0"][data-room-key="waste_percent"]',
        );
        input.value = '500';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(waste).toBeHidden();
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(page.locator('#rooms details.room-more').first()).toHaveAttribute('open', '');
      await expect(waste).toBeFocused();
      await expect(page.locator('#validationFeedback')).toBeVisible();
    });

    test('one-tap pills price exactly like the category select and keep scope within reach', async ({
      page,
    }) => {
      // At 390×844 the whole Check Scope panel, drawers closed, fits in at most one scroll: two
      // viewport heights. Narrower phones may scroll further but never sideways.
      const fits = async () => {
        const { panel, overflow } = await page.evaluate(() => ({
          panel: document.getElementById('panel-property').scrollHeight,
          overflow: document.documentElement.scrollWidth - innerWidth,
        }));
        expect(overflow).toBeLessThanOrEqual(0);
        if (width === 390) expect(panel).toBeLessThanOrEqual(2 * 844);
      };
      await scope(page, ['Bathroom']);
      await fits();
      // Job A: a category 3 room chosen with the select, loss still water.
      await page.locator('[data-room-index="0"][data-room-key="category"]').selectOption('3');
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(page.locator('#documents')).toBeVisible();
      const totals = async () => ({
        range: await page.locator('#estimateRange').textContent(),
        total: await page.locator('#itemizedTotal').textContent(),
        items: await page.evaluate(() =>
          state.documents.xactimate_scope.map((item) => [item.code, item.total]),
        ),
      });
      const selected = await totals();
      expect(selected.items.some(([code]) => code === 'ADR-DEMO')).toBe(true);
      // Job B: the same room answered with the Mold pill.
      const menu = page.locator('#jobMenu');
      if (!(await menu.evaluate((el) => el.open))) await menu.locator(':scope > summary').click();
      await page.locator('#newInspection').click();
      await expect(page.locator('#rooms .room')).toHaveCount(1);
      await scope(page, ['Bathroom', 'Hall']);
      await fits();
      await removeButton(page, 1).click();
      await page.locator('#confirmRoomRemoval').click();
      await lossPill(page, 0, 'mold').check();
      await expect(page.locator('[data-room-index="0"][data-room-key="category"]')).toHaveValue(
        '3',
      );
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(page.locator('#documents')).toBeVisible();
      expect(await totals()).toEqual(selected);
      await expect(page.locator('#reviewRooms .loss-tag')).toHaveText(['Bathroom · MOLD · Cat 3']);
    });

    test('a draft saved before the loss type existed seeds the tag it showed when it opens', async ({
      page,
    }) => {
      await scope(page, ['Kitchen', 'Bathroom']);
      await idle(page);
      // Older rooms have no loss key, and the server keeps an absent loss absent.
      await page.evaluate(() => {
        delete state.draft.data.rooms[0].loss;
        delete state.draft.data.rooms[1].loss;
        state.draft.data.rooms[1].category = 3;
        fillForm();
      });
      await saveDraft(page);
      await idle(page);
      const remoteRooms = () =>
        page.evaluate(async () =>
          (await jsonApi('/api/inspections/' + state.draft.inspection_id)).data.rooms.map(
            (room) => room.loss,
          ),
        );
      expect(await remoteRooms()).toEqual([undefined, undefined]);
      // Opening the editable draft seeds each loss type once: category 3 as mold, otherwise water.
      await page.evaluate(() => restoreDraft(state.draft.inspection_id));
      const cards = page.locator('#rooms .room');
      await expect(cards.nth(0).locator('.loss-tag')).toHaveText(['WATER · Cat 1']);
      await expect(cards.nth(1).locator('.loss-tag')).toHaveText(['MOLD · Cat 3']);
      await expect(lossPill(page, 1, 'mold')).toBeChecked();
      expect(await page.evaluate(() => state.draft.data.rooms.map((room) => room.loss))).toEqual([
        'water',
        'mold',
      ]);
      await idle(page);
      expect(await remoteRooms()).toEqual(['water', 'mold']);
      expect(await page.evaluate(() => state.conflict)).toBe(false);
      // Once seeded, the tag follows the selector, not the category.
      await page.locator('[data-room-index="0"][data-room-key="category"]').selectOption('3');
      await expect(cards.nth(0).locator('.loss-tag')).toHaveText(['WATER · Cat 3']);
      await expect(lossPill(page, 0, 'water')).toBeChecked();
      await page.locator('[data-room-index="1"][data-room-key="category"]').selectOption('1');
      await expect(cards.nth(1).locator('.loss-tag')).toHaveText(['MOLD · Cat 1']);
      await lossPill(page, 1, 'water').check();
      await expect(cards.nth(1).locator('.loss-tag')).toHaveText(['WATER · Cat 1']);
      expect(await page.evaluate(() => state.draft.data.rooms.map((room) => room.loss))).toEqual([
        'water',
        'water',
      ]);
    });

    test('a later signing error replaces an earlier save-not-confirmed status', async ({
      page,
    }) => {
      await audit(page, ['Kitchen']);
      await page.locator('#documentsConfirmed').check();
      await draw(page);
      await fault(page, { authorize: 1 });
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#authorizationStatus')).toContainText('Save not confirmed');
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }),
      );
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#authorizationStatus')).toHaveText(
        'Signing requires a connection.',
      );
      await page.evaluate(() => delete navigator.onLine);
    });
  });
