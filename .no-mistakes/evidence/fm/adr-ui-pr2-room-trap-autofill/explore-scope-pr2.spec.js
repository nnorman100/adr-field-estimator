const W = '/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56G40SDA319ABYWS96BYWHG';
const { test, expect } = require(W + '/node_modules/@playwright/test');
const { saveDraft } = require(W + '/tests/browser/actions');
const EV = '/home/nnorm/.no-mistakes/evidence/01M56G40SDA319ABYWS96BYWHG';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
const shot = (page, name) => page.screenshot({ path: `${EV}/${test.info().project.name}-${name}.png` });
const room = (page, i, key) => page.locator(`[data-room-index="${i}"][data-room-key="${key}"]`);

async function ready(page, notes) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled();
  await page.locator('#address').fill('Synthetic scope autofill property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill(notes);
}

test('visual: fresh Kitchen fill on 390x844, then confirm & finish', async ({ page }) => {
  await ready(page, 'Kitchen, category 2, 80 SF drywall. Use 3 fans.');
  await shot(page, '01-before-fill');
  const before = await page.evaluate(() => structuredClone(state.record.data.rooms));
  expect(before).toHaveLength(1);
  expect(before[0].name).toBe('Room 1');
  await page.locator('#fillScopeProperty').scrollIntoViewIfNeeded();
  const y0 = await page.evaluate(() => document.querySelector('.inspector')?.scrollTop ?? window.scrollY);
  await page.locator('#fillScopeProperty').tap();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(room(page, 0, 'name')).toHaveValue('Kitchen');
  await page.waitForTimeout(500);
  await shot(page, '02-after-fill-panel-at-top');
  await expect(page.locator('#rooms .room')).toHaveCount(1);
  await expect(room(page, 0, 'category')).toHaveValue('2');
  await expect(room(page, 0, 'finished_sf')).toHaveValue('80');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  // Look at the Kitchen room fields with markers
  await room(page, 0, 'finished_sf').scrollIntoViewIfNeeded();
  await shot(page, '03-kitchen-room-from-walkthrough-undo');
  await expect(room(page, 0, 'finished_sf').locator('..')).toContainText('From walkthrough · Undo');
  // Finish without confirming should not produce documents? check what happens
  await page.locator('#scopeSuggestionPanel').scrollIntoViewIfNeeded();
  const box = await page.locator('#confirmFilledScope').boundingBox();
  console.log('confirm button box', JSON.stringify(box));
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#scopeConfirmed')).toBeChecked();
  const fbox = await page.locator('#finishAudit').boundingBox();
  console.log('finish box', JSON.stringify(fbox));
  await shot(page, '04-confirmed-finish-visible');
  await page.touchscreen.tap(fbox.x + fbox.width / 2, fbox.y + fbox.height / 2);
  await expect(page.locator('#documents')).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, '05-documents-after-finish');
  const audit = await page.evaluate(() => ({ rooms: state.record.data.rooms.map((r) => [r.name, r.category, r.finished_sf]), confirmed: state.record.data.scope_confirmed, audit: !!state.record.audit }));
  expect(audit.rooms).toEqual([['Kitchen', 2, 80]]);
  expect(audit.confirmed).toBe(true);
  console.log('audit', JSON.stringify(audit));
});

test('adversarial: Undo Kitchen name and Undo added Hall together before save relabels photo back to Room 1', async ({ page }) => {
  const notes = 'Kitchen, category 2, 80 SF drywall. Hall, category 1, 20 SF subfloor.';
  await ready(page, notes);
  await page.route('**/scope-suggestions', async (route) => {
    const r = route.request().postDataJSON();
    await route.fulfill({ json: { inspection_id: r.inspection_id, revision: r.expected_revision, questions: [], changes: [
      { field: 'category', room: 'Kitchen', value: 2, source_quote: 'Kitchen, category 2, 80 SF drywall' },
      { field: 'finished_sf', room: 'Kitchen', value: 80, source_quote: 'Kitchen, category 2, 80 SF drywall' },
      { field: 'category', room: 'Hall', value: 1, source_quote: 'Hall, category 1, 20 SF subfloor' },
      { field: 'unfinished_sf', room: 'Hall', value: 20, source_quote: 'Hall, category 1, 20 SF subfloor' },
    ] } });
  });
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  const dataUrl = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 50; c.getContext('2d').fillRect(0, 0, 50, 50); return c.toDataURL('image/png'); });
  await page.locator('#photoFileInput').setInputFiles({ name: 'w.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
  await expect.poll(() => page.evaluate(() => state.draft.photos[0]?.uploaded)).toBe(true);
  await page.evaluate(async () => { await Promise.all([...state.ocr.values()]); });
  const original = await page.evaluate(() => state.record.photos[0]);
  expect(original.room).toBe('Room 1');
  await page.locator('#fillScope').click();
  await expect(room(page, 0, 'name')).toHaveValue('Kitchen');
  await expect(room(page, 1, 'name')).toHaveValue('Hall');
  await saveDraft(page);
  await expect.poll(() => page.evaluate(() => state.record.photos[0].room)).toBe('Kitchen');
  // Undo both without saving between
  await room(page, 0, 'name').locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
  await room(page, 1, 'name').locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#rooms .room')).toHaveCount(1);
  await expect(room(page, 0, 'name')).toHaveValue('Room 1');
  await saveDraft(page);
  await expect.poll(() => page.evaluate(() => state.record.photos[0].room)).toBe('Room 1');
  await page.reload();
  await expect(room(page, 0, 'name')).toHaveValue('Room 1');
  const after = await page.evaluate(() => state.record.photos[0]);
  console.log('photo after reload', JSON.stringify({ room: after.room, sameFile: after.file === original.file }));
  expect(after.room).toBe('Room 1');
  expect(after.file).toEqual(original.file);
  await shot(page, '06-combined-undo-reload-room1');
});

test('adversarial: an edited Room 1 is never replaced by a spoken Kitchen', async ({ page }) => {
  await ready(page, 'Kitchen, category 2, 80 SF drywall. Use 3 fans.');
  await room(page, 0, 'unfinished_sf').fill('5');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#rooms .room')).toHaveCount(2);
  await expect(room(page, 0, 'name')).toHaveValue('Room 1');
  await expect(room(page, 0, 'unfinished_sf')).toHaveValue('5');
  await expect(room(page, 1, 'name')).toHaveValue('Kitchen');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await room(page, 1, 'name').scrollIntoViewIfNeeded();
  await shot(page, '07-edited-room1-kept-kitchen-added');
});
