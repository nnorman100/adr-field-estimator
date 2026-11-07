const { saveDraft, checkScope } = require('./actions');
const { test, expect } = require('@playwright/test');
test.beforeEach(async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
});
async function task(page, name) {
  await page.locator('.task-nav [data-task="' + name + '"]').click();
}
async function menu(page, id) {
  await page.waitForFunction(() => state.session && !state.workspaceInitializing);
  const m = page.locator('#' + id);
  if (!(await m.evaluate((el) => el.open))) await m.locator(':scope > summary').click();
}
async function scope(page) {
  await task(page, 'property');
  await page.locator('#address').fill('Synthetic browser property');
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function audit(page) {
  await scope(page);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
}
async function draw(page) {
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  await canvas.click({ position: { x: 10, y: 10 } });
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 30, rect.y + 40);
  await page.mouse.down();
  await page.mouse.move(rect.x + 110, rect.y + 100, { steps: 8 });
  await page.mouse.move(rect.x + 220, rect.y + 30, { steps: 8 });
  await page.mouse.up();
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
test('permission denial, portrait evidence, clipboard denial and print document layout', async ({
  page,
  browserName,
}) => {
  await scope(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException('Synthetic permission denial', 'NotAllowedError');
        },
      },
    });
  });
  await task(page, 'walkthrough');
  await page.locator('#startWalk').click();
  await expect(page.locator('#message')).toContainText('Retry permissions');
  await expect(page.locator('#cameraEmpty')).toBeVisible();
  const photo = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 600;
    c.getContext('2d').fillRect(0, 0, 100, 100);
    return c.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({
    name: 'portrait.png',
    mimeType: 'image/png',
    buffer: Buffer.from(photo.split(',')[1], 'base64'),
  });
  await expect(page.locator('#photoGallery')).toContainText('300 × 600');
  await expect(page.locator('#photoGallery')).toContainText('no meter');
  await expect(page.locator('#photoCount')).toContainText('0 verified');
  await task(page, 'property');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error('denied');
        },
      },
    });
  });
  await menu(page, 'exportMenu');
  await page.locator('#copyJson').click();
  await expect(page.locator('#message')).toContainText('Download scope JSON');
  // No customer is saved for this job, so no customer line appears.
  await expect(page.locator('#proposalBody')).not.toContainText('Customer:');
  await expect(page.locator('#claimParty')).toHaveText(/^Property: /);
  await expect(page.locator('#defenseBody')).not.toContainText('Customer:');
  await expect(page.locator('#photoAuditLog .audit-photo p').first()).toHaveText(
    /^Photo 1 \(.+\)$/,
  );
  await page.emulateMedia({ media: 'print' });
  for (const id of ['doc-proposal', 'doc-claim', 'doc-defense', 'doc-photos'])
    await expect(page.locator('#' + id)).toBeVisible();
  // Owner-only mode has no company profile, so the documents name no company and show no logo.
  await expect(page.locator('#doc-proposal > h2')).toHaveText('Official proposal');
  await expect(page.locator('#doc-defense .document-letterhead img')).toBeHidden();
  await expect(page.locator('#doc-defense .document-letterhead p')).toHaveText('');
  await expect(page.locator('body')).not.toContainText(
    /Alert Disaster|Matthew Myers|950983|Bakersfield|426-2151/,
  );
  if (browserName === 'chromium')
    await page.pdf({
      path: test.info().outputPath('repaired-documents.pdf'),
      format: 'Letter',
      printBackground: true,
    });
});

test('revision conflict preserves local work and explicit recovery restores the server', async ({
  page,
}) => {
  await scope(page);
  await page.evaluate(async () => {
    const rows = await (
      await fetch('/api/inspections', {
        headers: { Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid') },
      })
    ).json();
    const id = rows.inspections[0].inspection_id;
    const record = await (
      await fetch('/api/inspections/' + id, {
        headers: { Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid') },
      })
    ).json();
    record.data.technician_notes = 'Edited in another tab';
    await fetch('/api/inspections/' + id, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid'),
      },
      body: JSON.stringify({ expected_revision: record.revision, data: record.data }),
    });
  });
  await page.locator('#technicianNotes').fill('Local work must survive');
  await saveDraft(page);
  await expect(page.locator('#conflictActions')).toBeVisible();
  await expect(page.locator('#technicianNotes')).toHaveValue('Local work must survive');
  await page.reload();
  await expect(page.locator('#conflictActions')).toBeVisible();
  await expect(page.locator('#technicianNotes')).toHaveValue('Local work must survive');
  await page.locator('#restoreRemote').click();
  await expect(page.locator('#technicianNotes')).toHaveValue('Edited in another tab');
});
test('worker update prompts, preserves the draft and keeps protected data out of caches', async ({
  page,
}) => {
  await scope(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.locator('#technicianNotes').fill('Preserve during installed update');
  await saveDraft(page);
  await fault(page, { worker: true });
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await expect(page.locator('#updateBanner')).toBeVisible();
  await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('#applyUpdate').click()]);
  await expect(page.locator('#technicianNotes')).toHaveValue('Preserve during installed update');
  const urls = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys()) result.push(request.url);
    return result;
  });
  expect(urls.filter((url) => url.includes('/api/'))).toEqual([]);
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator('#technicianNotes')).toHaveValue('Preserve during installed update');
  await page.context().setOffline(false);
});
test('reopening a draft after a signed job releases the signed photo object URLs', async ({
  page,
}) => {
  await page.locator('#address').fill('Draft to reopen');
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await menu(page, 'jobMenu');
  await page.locator('#newInspection').click();
  await expect(page.locator('#address')).toHaveValue('');
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 600;
    return c.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({
    name: 'signed.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
  await expect(page.locator('#photoGallery')).toContainText('no meter');
  await audit(page);
  await page.locator('#documentsConfirmed').check();
  await draw(page);
  await page.locator('#authorizeJob').click();
  await expect(page.locator('#saveStatus')).toHaveText('Signed');
  await expect.poll(() => page.evaluate(() => state.photoUrls.size)).toBe(1);
  const urls = await page.evaluate(() => {
    window.revokedUrls = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => {
      window.revokedUrls.push(url);
      revoke(url);
    };
    return [...state.photoUrls.values()];
  });
  await menu(page, 'jobMenu');
  await page.locator('#openJobs').click();
  await page.locator('.job-link').filter({ hasText: 'Draft to reopen' }).click();
  await expect(page.locator('#address')).toHaveValue('Draft to reopen');
  expect(await page.evaluate(() => [state.photoUrls.size, window.revokedUrls])).toEqual([
    0,
    expect.arrayContaining(urls),
  ]);
});
test('saved jobs list is newest first and loads older signed jobs', async ({ page }) => {
  await page.evaluate(async () => {
    const response = await fetch('/__test/seed-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: sessionStorage.getItem('synthetic-uid') }),
    });
    if (!response.ok) throw Error('Synthetic seed failed');
  });
  await menu(page, 'jobMenu');
  await page.locator('#openJobs').click();
  const signed = page.locator('.job-link').filter({ hasText: 'Synthetic signed job' });
  await expect(signed).toHaveCount(100);
  await expect(signed.first()).toContainText('job 104');
  await expect(signed.last()).toContainText('job 005');
  await page.getByRole('button', { name: 'Load older signed jobs' }).click();
  await expect(signed).toHaveCount(105);
  await expect(signed.last()).toContainText('job 000');
  await expect(page.getByRole('button', { name: 'Load older signed jobs' })).toBeHidden();
});

for (const failure of ['evidence', 'record'])
  test('durable signing receipt survives ' + failure + ' display failure', async ({ page }) => {
    await audit(page);
    await page.locator('#documentsConfirmed').check();
    await draw(page);
    await fault(page, { [failure]: 1 });
    await page.locator('#authorizeJob').click();
    await expect(page.locator('#saveStatus')).toHaveText('Signed');
    await expect(page.locator('#retrySavedEvidence')).toBeVisible();
    await expect(page.locator('#message')).toContainText('saved');
    await expect(page.locator('#address')).toBeDisabled();
    await page.locator('#retrySavedEvidence').click();
    await expect(page.locator('#savedSignature')).toBeVisible();
    await expect(page.locator('#retrySavedEvidence')).toBeHidden();
    const { references } = await fault(page, {});
    expect(references).toHaveLength(1);
  });

test('walkthrough form fill auto-applies quoted values, supports Undo and invalidates old documents', async ({
  page,
}) => {
  await audit(page);
  await task(page, 'walkthrough');
  await page.locator('details:has(#technicianTranscript) summary').click();
  await page
    .locator('#technicianTranscript')
    .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await page.locator('#fillScope').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await expect(page.locator('#airMovers')).toHaveValue('3');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await expect(page.locator('#scopeQuestions')).toContainText('Confirm any additional labor.');
  await page
    .locator('#airMovers')
    .locator('..')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await expect(page.locator('[data-room-key="category"]')).toHaveValue('2');
  await expect(page.locator('#airMovers')).toHaveValue('0');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await expect(page.locator('#documents')).toBeHidden();
  await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.reload();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#itemizedTotal')).toHaveText('$1,411.40');
});

test('scope suggestions dismiss and manual edits preserve user values', async ({ page }) => {
  await page
    .locator('#technicianNotes')
    .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.locator('#dismissScopeSuggestions').click();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.locator('#airMovers').fill('6');
  await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
  await expect(page.locator('#airMovers')).toHaveValue('6');
});

test('a dehumidifier typed after a blocked audit and walkthrough detour replaces the 0 and is priced', async ({
  page,
}) => {
  // The 2026-10-17 phone test: a prefilled 0 left the caret after it, so typing 1 showed "01".
  await page.setViewportSize({ width: 390, height: 844 });
  await task(page, 'walkthrough');
  await page.locator('details:has(#technicianTranscript) summary').click();
  await page
    .locator('#technicianTranscript')
    .fill('Room 1, clean water. Set one dehumidifier for 3 days.');
  await scope(page);
  const blocked = page.waitForResponse((r) => r.url().endsWith('/api/audit'));
  await page.locator('#finishAudit').click();
  const first = (await (await blocked).json()).audit.documents;
  expect(first.signable).toBe(false);
  expect(first.unpriced_work).toHaveLength(1);
  await task(page, 'property');
  await page.locator('#panel-property .section-head [data-task="walkthrough"]').click();
  await expect(page.locator('#panel-walkthrough')).toBeVisible();
  await task(page, 'property');
  const box = page.locator('#dehumidifiers');
  await expect(box).toHaveValue('0');
  await expect(box).toHaveAttribute('inputmode', 'numeric');
  await expect(page.locator('#laborHours')).toHaveAttribute('inputmode', 'decimal');
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveAttribute(
    'inputmode',
    'decimal',
  );
  const saves = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/inspections/')) saves.push(r.postDataJSON());
  });
  await expect(page.locator('#scopeConfirmNotice')).toBeHidden();
  await box.click();
  await page.keyboard.type('1');
  await expect(box).toHaveValue('1');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await expect(page.locator('#scopeConfirmNotice')).toHaveText('Scope changed · confirm again.');
  await page.locator('#scopeConfirmed').check();
  await expect(page.locator('#scopeConfirmNotice')).toBeHidden();
  const audited = page.waitForResponse((r) => r.url().endsWith('/api/audit'));
  // Inside the 1.5 s save debounce: Finish & review must flush the pending save itself.
  expect(saves).toHaveLength(0);
  await page.locator('#finishAudit').click();
  const documents = (await (await audited).json()).audit.documents;
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.map((body) => body.data.dehumidifiers)).toEqual(saves.map(() => 1));
  expect(documents.unpriced_work).toEqual([]);
  expect(documents.signable).toBe(true);
  expect(documents.xactimate_scope.find((item) => item.code === 'ADR-DEHU')).toMatchObject({
    quantity: 3,
  });
});
