const { test, expect } = require('@playwright/test');
const { checkScope } = require('./actions');
const uid = (role) => 'test-owner-ws-' + role;
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true, ai_features: ['readiness'] } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/fault', { data: { uid: uid('estimator'), faults: {} } });
  await request.post('/__test/workspaces', { data: { enabled: false } });
});
async function open(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function scope(page) {
  await checkScope(page);
  await page.locator('#address').fill('Synthetic readiness property');
  await page.locator('#yearBuilt').fill('2000');
  await page.locator('[data-room-key="finished_sf"]').first().fill('10');
  await page.locator('#scopeConfirmed').check();
}
for (const width of [320, 390]) {
  for (const role of ['owner', 'estimator']) {
    test(`${role} readiness Fix and Continue at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await open(page, role);
      await expect(page.locator('#readinessCount')).toContainText('Still missing:');
      await scope(page);
      await page.locator('#finishAudit').click();
      const dialog = page.getByRole('dialog', { name: 'Ready to review?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(
        'Nothing here blocks the documents. Fix what you can, or continue.',
      );
      await expect(dialog).toContainText(
        'Signing is blocked by an unconfirmed scope, unpriced items, pending extras, pending OCR, no priced work, incomplete company setup, voice notes still recording, uploading or unreviewed, or an out-of-date audit.',
      );
      await expect(dialog).toContainText('No floor area for the drying check');
      await expect(dialog.locator('h3')).toContainText(['Room 1', 'Whole job']);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (width === 320) {
        const gap = dialog.locator('.readiness-gap').first();
        const text = await gap.locator('span').boundingBox(),
          button = await gap.locator('button').boundingBox();
        expect(button.y).toBeGreaterThanOrEqual(text.y + text.height);
      }
      await dialog
        .getByRole('button', {
          name: 'Fix: No floor area for the drying check · Room 1',
          exact: true,
        })
        .click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('[data-room-key="floor_sf"]').first()).toBeFocused();
      // Removing a gap does not produce a new interruption, even when the revision changes.
      await page.locator('[data-room-key="floor_sf"]').first().fill('100');
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('#documents')).toBeVisible();
      await checkScope(page);
      // A newly missing field returns the dialog; Continue still reaches the audit.
      await page.locator('#dehumidifiers').fill('1');
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('No dehumidifier AHAM');
      await page.locator('#readinessContinue').click();
      await expect(page.locator('#documents')).toBeVisible();
      await page.locator('#jobMenu > summary').click();
      await page.locator('#helpButton').click();
      await expect(page.locator('[data-help-topic="readiness"]')).toBeVisible();
    });
  }
  test(`office never sees readiness at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, 'office');
    await expect(page.locator('#readinessCount')).toBeHidden();
    await expect(page.locator('#finishAudit')).toBeDisabled();
    await page.locator('#jobMenu > summary').click();
    await page.locator('#helpButton').click();
    await expect(page.locator('[data-help-topic="readiness"]')).toBeHidden();
  });
}
test('offline list, failed audit retry, and flag off', async ({ page, context, request }) => {
  await open(page, 'estimator');
  await scope(page);
  await page.locator('#airMovers').fill('1');
  await page.locator('#scopeConfirmed').check();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await context.setOffline(true);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#readinessDialog')).toBeVisible();
  await expect(page.locator('#readinessOffline')).toBeVisible();
  await expect(page.locator('#readinessGaps')).toContainText('Readings unknown offline');
  await page.locator('#readinessContinue').click();
  await expect(page.locator('#message')).toContainText('Connect to generate documents');
  await context.setOffline(false);
  await request.post('/__test/fault', { data: { uid: uid('estimator'), faults: { audit: 1 } } });
  await page.locator('#finishAudit').click();
  // Newly known setup gap replaces offline unknown, so it is shown once.
  await expect(page.locator('#readinessDialog')).toBeVisible();
  await page.locator('#readinessContinue').click();
  await expect(page.locator('#message')).toContainText(/retry|unavailable|fail/i);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await request.post('/__test/workspaces', { data: { enabled: true } });
  await page.reload();
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#readinessCount')).toBeHidden();
});

for (const width of [320, 390])
  test(`superadmin support stays read only at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('admin'),
    );
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.getByRole('button', { name: 'Manage companies', exact: true }).click();
    await page
      .locator('.dashboard-card')
      .filter({ has: page.getByRole('heading', { name: 'Alert Disaster Restoration' }) })
      .getByRole('button', { name: 'Manage company' })
      .click();
    await page.getByRole('button', { name: 'Open read-only support view' }).click();
    await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await expect(page.locator('#dashboardHeading')).toHaveText('Job details');
    await expect(page.locator('#readinessCount')).toBeHidden();
    await expect(page.locator('#readinessDialog')).toBeHidden();
    await page.locator('#helpButton').click();
    await expect(page.locator('[data-help-topic="readiness"]')).toBeHidden();
  });

test('loading readings stay unknown until the existing log load completes', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/inspections/*/readings', async (route) => {
    await held;
    await route.continue();
  });
  await open(page, 'estimator');
  await scope(page);
  await page.locator('#airMovers').fill('1');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#readinessGaps')).toContainText('Readings not loaded');
  await page.locator('#readinessBack').click();
  release();
  await expect(page.locator('#addReading')).toBeEnabled();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#readinessGaps')).toContainText(
    'No setup-day affected air or material reading',
  );
  await page.locator('#readinessBack').click();
});

test('a connected relay is notified after claim and reading saves and the dialog names Live', async ({
  page,
}) => {
  await open(page, 'estimator');
  await scope(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  // Fake only the connected transport. The claim and reading controls use their real routes.
  await page.evaluate(() => {
    window.readinessPackets = [];
    state.liveReady = true;
    state.shotUpdates = true;
    state.liveShotSignature = shotSignature(state.record);
    state.socket = {
      readyState: WebSocket.OPEN,
      send: (raw) => window.readinessPackets.push(JSON.parse(raw)),
      close() {
        this.readyState = 3;
      },
    };
  });
  await page.locator('#claimDetails > summary').click();
  await page.locator('#claimCarrier').fill('Synthetic Carrier');
  await page.locator('#saveClaim').click();
  await expect(page.locator('#claimStatus')).toHaveText('Claim details saved.');
  await expect
    .poll(() => page.evaluate(() => window.readinessPackets.some((p) => p.type === 'shots')))
    .toBe(true);
  await page.evaluate(() => {
    window.readinessPackets = [];
  });
  await page.locator('#addReading').click();
  await page.locator('#readingTemp').fill('70');
  await page.locator('#readingRh').fill('50');
  await page.locator('#saveReading').click();
  await expect(page.locator('#message')).toHaveText('Reading saved.');
  await expect
    .poll(() => page.evaluate(() => window.readinessPackets.some((p) => p.type === 'shots')))
    .toBe(true);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#readinessLive')).toBeVisible();
  await expect(page.locator('#readinessGaps')).toContainText('No claim number');
  await page.locator('#readinessBack').click();
  await page.evaluate(() => {
    state.liveReady = false;
    state.socket = null;
    state.shotUpdates = false;
    clearTimeout(state.shotTimer);
  });
});

test('Fix for unknown offline readings does not open an online-only entry form', async ({
  page,
  context,
}) => {
  await open(page, 'estimator');
  await scope(page);
  await page.locator('#airMovers').fill('1');
  await page.locator('#scopeConfirmed').check();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await context.setOffline(true);
  await page.locator('#finishAudit').click();
  await page.getByRole('button', { name: 'Fix: Readings not loaded', exact: true }).click();
  await expect(page.locator('#readinessDialog')).toBeHidden();
  await expect(page.locator('#readingDialog')).toBeHidden();
  await expect(page.locator('#addReading')).toBeDisabled();
});

for (const category of [1, 2, 3]) {
  test(`legacy displayed loss can be confirmed without repricing category ${category}`, async ({
    page,
  }) => {
    await open(page, 'estimator');
    await page.evaluate((category) => {
      const room = state.draft.data.rooms[0];
      delete room.loss;
      room.category = category;
      renderRooms();
    }, category);
    await checkScope(page);
    const selected = page.locator('[data-room-key="loss"]:checked').first();
    const displayed = await selected.inputValue();
    await selected.locator('..').click();
    await expect.poll(() => page.evaluate(() => state.draft.data.rooms[0].loss)).toBe(displayed);
    expect(await page.evaluate(() => state.draft.data.rooms[0].category)).toBe(category);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await expect.poll(() => page.evaluate(() => state.record.data.rooms[0].loss)).toBe(displayed);
    expect(
      await page.evaluate(() => state.record.readiness.gaps.some((gap) => gap.code === 'loss')),
    ).toBe(false);
  });
}

test.describe('estimate warnings in the dialog', () => {
  const BELOW = 'Fewer than the IICRC minimum of 3 for the wet floor areas.';
  const ABOVE = 'More than the IICRC floor-based maximum of 4.';
  const HEADING = 'Check before you finish';
  const NOTE = 'Warnings update once the draft saves.';
  const dialogOf = (page) => page.getByRole('dialog', { name: 'Ready to review?' });
  const features = (request, ai_features) =>
    request.post('/__test/workspaces', { data: { enabled: true, ai_features } });
  async function sized(page, airMovers) {
    await scope(page);
    await page.locator('#rooms .room-more summary').first().click();
    await page.locator('[data-room-key="floor_sf"]').first().fill('140');
    await page.locator('[data-room-key="ceiling_height_ft"]').first().fill('8');
    await page.locator('[data-room-key="water_class"]').first().selectOption('2');
    await page.locator('details.more-equipment summary').click();
    await page.locator('#dehumidifierPpd').fill('70');
    await page.locator('#dehumidifiers').fill('1');
    await page.locator('#airMovers').fill(String(airMovers));
    await page.locator('#scopeConfirmed').check();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
  }

  for (const width of [320, 390])
    test(`a sizing warning shows, Fix opens the count and it clears once saved at ${width}`, async ({
      page,
      request,
    }) => {
      await features(request, ['readiness', 'estimate_assist']);
      await page.setViewportSize({ width, height: 844 });
      await open(page, 'estimator');
      await sized(page, 2);
      await page.locator('#finishAudit').click();
      const dialog = dialogOf(page);
      await expect(dialog).toBeVisible();
      const section = page.locator('#readinessWarnings');
      await expect(section.locator('h3')).toHaveText(HEADING);
      await expect(section).toContainText(BELOW);
      await expect(section).not.toContainText(NOTE);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await dialog.getByRole('button', { name: 'Fix: ' + BELOW, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('#airMovers')).toBeFocused();
      await expect(page.locator('#airMovers')).toBeInViewport();
      await page.locator('#airMovers').fill('3');
      await page.locator('#scopeConfirmed').check();
      await expect(page.locator('#saveStatus')).toHaveText('Saved');
      expect(await page.evaluate(() => state.record.warnings)).toEqual([]);
      // Nothing new since the last Finish: straight to the documents, with no warning left.
      await page.locator('#finishAudit').click();
      await expect(page.locator('#documents')).toBeVisible();
      await expect(page.locator('#auditWarnings')).not.toContainText('IICRC');
    });

  test('the review screen repeats a warning, off the printed page, and signing stays open', async ({
    page,
    request,
  }) => {
    await features(request, ['readiness', 'estimate_assist']);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'estimator');
    await sized(page, 9);
    await page.locator('#finishAudit').click();
    await expect(page.locator('#readinessWarnings')).toContainText(ABOVE);
    await page.locator('#readinessContinue').click();
    await expect(page.locator('#documents')).toBeVisible();
    await expect(page.locator('#auditWarnings')).toContainText(ABOVE);
    expect(await page.evaluate(() => state.documents.signable)).toBe(true);
    await expect(page.locator('#authorizeJob')).toBeEnabled();
    const printed = await page.locator('[id^="doc-"]').allTextContents();
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.join(' ')).not.toContain(ABOVE);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#auditWarnings')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
    // Already listed: the dialog does not come back for the same warning.
    await checkScope(page);
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await expect(page.locator('#documents')).toBeVisible();
    await expect(dialogOf(page)).toBeHidden();
  });

  const inspectionPut = /\/api\/inspections\/[^/]+$/;
  async function holdSaves(page) {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(inspectionPut, async (route) => {
      if (route.request().method() === 'PUT') await held;
      await route.continue();
    });
    return release;
  }

  for (const ai_features of [['estimate_assist'], ['readiness', 'estimate_assist']])
    test(`an edit made just before Finish is saved and listed with ${ai_features}`, async ({
      page,
      request,
    }) => {
      await features(request, ai_features);
      await open(page, 'estimator');
      await sized(page, 3);
      const release = await holdSaves(page);
      await page.locator('#airMovers').fill('9');
      await page.locator('#scopeConfirmed').check();
      expect(await page.evaluate(() => stable(state.draft.data) !== state.ack)).toBe(true);
      await page.locator('#finishAudit').click();
      const dialog = dialogOf(page),
        section = page.locator('#readinessWarnings');
      await expect(page.locator('#finishAudit')).toBeDisabled();
      await expect(dialog).toBeHidden();
      release();
      await expect(dialog).toBeVisible();
      await expect(section).toContainText(ABOVE);
      await expect(section).not.toContainText(NOTE);
      expect(await page.evaluate(() => state.record.data.air_movers)).toBe(9);
      await page.locator('#readinessContinue').click();
      await expect(page.locator('#documents')).toBeVisible();
      await expect(page.locator('#auditWarnings')).toContainText(ABOVE);
    });

  test('a save that fails before the check keeps the draft, opens no dialog and runs no audit', async ({
    page,
    request,
  }) => {
    await features(request, ['readiness', 'estimate_assist']);
    await open(page, 'estimator');
    await sized(page, 3);
    const audits = [];
    page.on('request', (sent) => {
      if (sent.url().endsWith('/api/audit')) audits.push(sent);
    });
    await page.route(inspectionPut, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, json: { detail: 'Synthetic save failure.' } })
        : route.continue(),
    );
    await page.locator('#airMovers').fill('9');
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await expect(page.locator('#message')).toHaveText('Synthetic save failure.');
    await expect(page.locator('#finishAudit')).toBeEnabled();
    await expect(dialogOf(page)).toBeHidden();
    await expect(page.locator('#documents')).toBeHidden();
    expect(audits).toEqual([]);
    expect(await page.evaluate(() => state.draft.data.air_movers)).toBe(9);
    // Finish again once saves work: the warning for that edit is listed.
    await page.unroute(inspectionPut);
    await page.locator('#finishAudit').click();
    await expect(dialogOf(page)).toBeVisible();
    await expect(page.locator('#readinessWarnings')).toContainText(ABOVE);
    await page.locator('#readinessBack').click();
  });

  test('with warnings off the readiness dialog does not wait for the save', async ({ page }) => {
    await open(page, 'estimator');
    await sized(page, 3);
    const release = await holdSaves(page);
    await page.locator('#airMovers').fill('9');
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await expect(dialogOf(page)).toBeVisible();
    await page.locator('#readinessBack').click();
    release();
  });

  test('an unsaved change says warnings update, and a new one opens the dialog after the save', async ({
    page,
    request,
  }) => {
    await features(request, ['readiness', 'estimate_assist']);
    await open(page, 'estimator');
    await sized(page, 3);
    await page.locator('#airMovers').fill('9');
    await page.locator('#scopeConfirmed').check();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const dialog = dialogOf(page),
      section = page.locator('#readinessWarnings');
    // A draft Finish could not save lists the job's gaps, and not the warning for older numbers.
    const ack = await page.evaluate(() => {
      const saved = state.ack;
      state.ack = 'unsaved';
      void confirmReadiness();
      return saved;
    });
    await expect(dialog).toBeVisible();
    await expect(section.locator('h3')).toHaveText(HEADING);
    await expect(section).toContainText(NOTE);
    await expect(section).not.toContainText(ABOVE);
    await page.locator('#readinessBack').click();
    await page.evaluate((saved) => {
      state.ack = saved;
    }, ack);
    await page.locator('#finishAudit').click();
    await expect(dialog).toBeVisible();
    await expect(section).toContainText(ABOVE);
    await expect(section).not.toContainText(NOTE);
    await page.locator('#readinessBack').click();
    // An unsaved edit does not forget a listed warning, so the next save does not ask again.
    const kept = await page.evaluate(async () => {
      const ack = state.ack;
      state.ack = 'unsaved';
      const accepted = await confirmReadiness();
      state.ack = ack;
      return { accepted, keys: state.draft.readinessFinish };
    });
    expect(kept.accepted).toBe(true);
    expect(kept.keys).toContain(JSON.stringify(['warning', 'air_movers_above', '']));
  });

  test('with readiness off the dialog opens for a warning alone and not otherwise', async ({
    page,
    context,
    request,
  }) => {
    await features(request, ['estimate_assist']);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'estimator');
    await expect(page.locator('#readinessCount')).toBeHidden();
    await sized(page, 2);
    await context.setOffline(true);
    await page.locator('#finishAudit').click();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    await expect(page.locator('#readinessWarnings')).toContainText(BELOW);
    await expect(page.locator('#readinessGaps')).toBeEmpty();
    await expect(page.locator('#readinessOffline')).toBeHidden();
    await page.locator('#readinessBack').click();
    await context.setOffline(false);
    await page.locator('#finishAudit').click();
    await expect(page.locator('#documents')).toBeVisible();
    await checkScope(page);
    await page.locator('#airMovers').fill('3');
    await page.locator('#scopeConfirmed').check();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await page.locator('#finishAudit').click();
    await expect(page.locator('#documents')).toBeVisible();
    await expect(dialog).toBeHidden();
  });

  test('offline shows the last saved warnings with the note once the draft changes', async ({
    page,
    context,
    request,
  }) => {
    await features(request, ['readiness', 'estimate_assist']);
    await open(page, 'estimator');
    await sized(page, 2);
    await context.setOffline(true);
    await page.locator('#airMovers').fill('3');
    await page.locator('#finishAudit').click();
    const section = page.locator('#readinessWarnings');
    await expect(section).toContainText(BELOW);
    await expect(section).toContainText(NOTE);
    await page.locator('#readinessBack').click();
    await context.setOffline(false);
  });

  test('the flag off lists no warnings, and office staff get no dialog', async ({
    page,
    request,
  }) => {
    await open(page, 'estimator');
    await sized(page, 2);
    await page.locator('#finishAudit').click();
    await expect(dialogOf(page)).toBeVisible();
    await expect(page.locator('#readinessWarnings')).toBeEmpty();
    expect(await page.evaluate(() => 'warnings' in state.record)).toBe(false);
    await page.locator('#readinessBack').click();

    await features(request, ['readiness', 'estimate_assist']);
    await page.reload();
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('office'),
    );
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await expect(page.locator('#finishAudit')).toBeDisabled();
    await page.locator('#jobMenu > summary').click();
    await page.locator('#helpButton').click();
    await expect(page.locator('[data-help-feature="estimate_assist"]').first()).toContainText(
      HEADING,
    );
  });
});
