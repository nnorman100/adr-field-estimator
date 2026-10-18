const { test, expect } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56G40SDA319ABYWS96BYWHG/node_modules/@playwright/test');
const EV = '/home/nnorm/.no-mistakes/evidence/01M56G40SDA319ABYWS96BYWHG';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
const room = (page, i, key) => page.locator(`[data-room-index="${i}"][data-room-key="${key}"]`);
async function ready(page, notes) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled();
  await page.locator('#address').fill('Synthetic adversarial property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill(notes);
}
async function photo(page) {
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  const dataUrl = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 40; c.getContext('2d').fillRect(0,0,40,40); return c.toDataURL('image/png'); });
  await page.locator('#photoFileInput').setInputFiles({ name: 'w.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
  await expect.poll(() => page.evaluate(() => state.draft.photos[0]?.uploaded)).toBe(true);
  await page.evaluate(async () => { await Promise.all([...state.ocr.values()]); });
}
const tag = () => test.info().project.name;

test('touched default Room 1 (5 SF) is kept and Kitchen is added beside it', async ({ page }) => {
  await ready(page, 'Kitchen, category 2, 80 SF drywall. Use 3 fans.');
  await room(page, 0, 'finished_sf').fill('5');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#rooms .room')).toHaveCount(2);
  await expect(room(page, 0, 'name')).toHaveValue('Room 1');
  await expect(room(page, 0, 'finished_sf')).toHaveValue('5');
  await expect(room(page, 1, 'name')).toHaveValue('Kitchen');
  await expect(room(page, 1, 'finished_sf')).toHaveValue('80');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
});

test('Kitchen+Hall fill then Undo Kitchen name and Undo Hall before save relabels photo back to Room 1', async ({ page }) => {
  const notes = 'Kitchen, category 2, 80 SF drywall. Hall, category 2, 40 SF drywall.';
  await ready(page, notes);
  await page.route('**/scope-suggestions', async (route) => {
    const r = route.request().postDataJSON();
    const k = 'Kitchen, category 2, 80 SF drywall', h = 'Hall, category 2, 40 SF drywall';
    await route.fulfill({ json: { inspection_id: r.inspection_id, revision: r.expected_revision, questions: [], changes: [
      { field: 'category', room: 'Kitchen', value: 2, source_quote: k },
      { field: 'finished_sf', room: 'Kitchen', value: 80, source_quote: k },
      { field: 'category', room: 'Hall', value: 2, source_quote: h },
      { field: 'finished_sf', room: 'Hall', value: 40, source_quote: h } ] } });
  });
  await photo(page);
  expect(await page.evaluate(() => state.record.photos[0].room)).toBe('Room 1');
  const file = await page.evaluate(() => state.record.photos[0].file);
  await page.locator('#fillScope').click();
  await expect(page.locator('#rooms .room')).toHaveCount(2);
  await expect(room(page, 0, 'name')).toHaveValue('Kitchen');
  await expect(room(page, 1, 'name')).toHaveValue('Hall');
  await page.locator('#saveDraft').click();
  await expect.poll(() => page.evaluate(() => state.record.photos[0].room)).toBe('Kitchen');
  await room(page, 0, 'name').locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
  await room(page, 1, 'name').locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#rooms .room')).toHaveCount(1);
  await expect(room(page, 0, 'name')).toHaveValue('Room 1');
  await page.locator('#saveDraft').click();
  await expect.poll(() => page.evaluate(() => state.record.photos[0].room)).toBe('Room 1');
  await page.reload();
  await expect(room(page, 0, 'name')).toHaveValue('Room 1');
  expect(await page.evaluate(() => state.record.photos[0])).toMatchObject({ room: 'Room 1', file });
});

test('a 0 SF room still blocks documents after walkthrough fill + Undo', async ({ page }) => {
  await ready(page, 'Kitchen, category 2, 80 SF drywall. Use 3 fans.');
  await page.locator('#fillScopeProperty').click();
  await expect(room(page, 0, 'name')).toHaveValue('Kitchen');
  await room(page, 0, 'finished_sf').locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(room(page, 0, 'finished_sf')).toHaveValue('0');
  await page.locator('#airMovers').locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#airMovers')).toHaveValue('0');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({ docs: state.documents, audit: state.record.audit }));
  await page.screenshot({ path: `${EV}/zero-sf-blocked-${tag()}.png` });
  const signable = st.docs?.signable ?? st.audit?.signable;
  expect(signable).toBe(false);
  await expect(page.getByText("Can't sign yet").first()).toBeVisible();
  console.log('ZERO-SF', JSON.stringify({ signable, blocked: st.docs?.unpriced_work ?? st.audit?.unpriced_work }).slice(0, 400));
});

test('visual: autofill summary at 390x844 then Confirm + Finish reach documents', async ({ page }) => {
  await ready(page, 'Kitchen, category 2, 80 SF drywall. Use 3 fans.');
  await page.screenshot({ path: `${EV}/01-before-fill-${tag()}.png` });
  await page.locator('#fillScopeProperty').scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY);
  const b = await page.locator('#fillScopeProperty').boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${EV}/02-after-fill-panel-top-${tag()}.png` });
  await page.locator('#rooms').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EV}/03-room-kitchen-walkthrough-undo-${tag()}.png` });
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await page.locator('#scopeSuggestionPanel').scrollIntoViewIfNeeded();
  for (const s of ['#confirmFilledScope', '#finishAudit']) {
    const bb = await page.locator(s).boundingBox();
    expect(bb.y).toBeGreaterThanOrEqual(0); expect(bb.y + bb.height).toBeLessThanOrEqual(844);
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
  }
  await expect(page.locator('#documents')).toBeVisible();
  await page.screenshot({ path: `${EV}/04-documents-${tag()}.png` });
  console.log('scroll-before-fill', before);
});
