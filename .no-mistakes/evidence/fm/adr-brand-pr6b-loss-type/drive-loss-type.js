const W = process.argv[2];
const { chromium, expect } = require(W + '/node_modules/@playwright/test');
const EV = '/home/nnorm/.no-mistakes/evidence/01M58KZ2JDGSYGW2QGV0A1XV0R/';
const BASE = 'http://localhost:8799';
const log = (...a) => console.log(...a);
const sel = (i, k) => `[data-room-index="${i}"][data-room-key="${k}"]`;
const results = {};
async function run(name, fn) {
  try { await fn(); results[name] = 'PASS'; log('PASS', name); }
  catch (e) { results[name] = 'FAIL'; log('FAIL', name, e.message.split('\n').slice(0, 6).join(' | ')); }
}
async function newPage(browser, uid, viewport = { width: 1280, height: 900 }) {
  const mobile = viewport.width < 500;
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message));
  await page.addInitScript((v) => sessionStorage.setItem('synthetic-uid', v), uid);
  return page;
}
async function idle(page) {
  await page.waitForTimeout(1900);
  await page.evaluate(async () => { await syncChain.catch(() => {}); });
  await expect.poll(() => page.evaluate(() => state.syncing)).toBe(false);
}
async function saveDraft(page) {
  const menu = page.locator('#jobMenu');
  if (!(await menu.evaluate((el) => el.open))) await menu.locator('summary').click();
  await page.locator('#saveDraft').click();
}
async function property(page) {
  await page.goto(BASE + '/');
  await expect(page.locator('#address')).toBeEnabled();
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('Synthetic loss-type property');
  await page.locator('#yearBuilt').fill('1998');
}
const api = (page, path, method = 'GET', body) => page.evaluate(async ([p, m, b]) => {
  const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid'), ...(state.session?.workspaces_enabled ? { 'X-ADR-Workspace-Protocol': '1' } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) });
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}, [path, method, body]);

(async () => {
  const browser = await chromium.launch();
  await fetch(BASE + '/__test/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' });

  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone390', { width: 390, height: 844 }]])
  await run('S1 manual loss selector beside category, cat-3 water stays WATER (' + label + ')', async () => {
    const page = await newPage(browser, 'test-owner-lt-s1' + label, viewport);
    await property(page);
    await page.locator(sel(0, 'name')).fill('Kitchen');
    await page.locator(sel(0, 'finished_sf')).fill('10');
    await page.locator('#addRoom').click();
    await page.locator(sel(1, 'name')).fill('Laundry');
    await page.locator(sel(1, 'finished_sf')).fill('40');
    await expect(page.locator(sel(1, 'loss'))).toHaveValue('water');
    const opts = await page.locator(sel(1, 'loss') + ' option').allTextContents();
    log('  loss options:', JSON.stringify(opts));
    await page.locator(sel(1, 'category')).selectOption('3');
    const card = page.locator('#rooms .room').nth(1);
    await expect(card.locator('.loss-tag')).toHaveText(['WATER · Cat 3']);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: EV + `s1-${label}-cat3-water.png` });
    await page.locator(sel(1, 'loss')).selectOption('mold');
    await expect(card.locator('.loss-tag')).toHaveText(['MOLD · Cat 3']);
    await page.locator(sel(1, 'loss')).selectOption('both');
    await expect(card.locator('.loss-tag')).toHaveText(['WATER · Cat 3', 'MOLD · Cat 3']);
    await card.screenshot({ path: EV + `s1-${label}-cat3-both.png` });
    await page.locator('#rooms').screenshot({ path: EV + `s1-${label}-rooms.png` });
    await page.locator('#scopeConfirmed').scrollIntoViewIfNeeded();
    log('  hit at checkbox:', await page.locator('#scopeConfirmed').evaluate((el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t ? t.outerHTML.slice(0, 120) : 'none'; }), 'checked', await page.locator('#scopeConfirmed').isChecked());
    await page.locator('#scopeConfirmed').check();
    await saveDraft(page);
    await idle(page);
    const rec = await api(page, '/api/inspections/' + await page.evaluate(() => state.draft.inspection_id));
    log('  saved rooms:', JSON.stringify(rec.body.data.rooms.map((r) => [r.name, r.category, r.loss])));
    expect(rec.body.data.rooms.map((r) => r.loss)).toEqual(['water', 'both']);
    await page.locator('#finishAudit').click();
    await expect(page.locator('#documents')).toBeVisible();
    await expect(page.locator('#reviewRooms .loss-tag')).toHaveText(['Kitchen · WATER · Cat 1', 'Laundry · WATER · Cat 3', 'Laundry · MOLD · Cat 3']);
    await page.locator('#reviewRooms').screenshot({ path: EV + `s1-${label}-review-tags.png` });
    await page.context().close();
  });

  await run('S2 Fill scope sets loss from walkthrough answer; cat-3 no-mold room tagged WATER', async () => {
    const page = await newPage(browser, 'test-owner-lt-s2', { width: 390, height: 844 });
    await property(page);
    await page.locator(sel(0, 'name')).fill('Laundry');
    await page.locator('#addRoom').click();
    await page.locator(sel(1, 'name')).fill('Closet');
    await expect(page.locator(sel(1, 'loss'))).toHaveValue('water');
    await page.locator('#technicianNotes').fill('Laundry is black water, category 3, no mold, 40 SF drywall. Closet has mold, 20 SF drywall.');
    await page.locator('#fillScopeProperty').click();
    await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
    const rooms = await page.evaluate(() => state.draft.data.rooms.map((r) => [r.name, r.category, r.loss]));
    log('  rooms after fill:', JSON.stringify(rooms));
    const laundry = rooms.findIndex((r) => r[0] === 'Laundry'), closet = rooms.findIndex((r) => r[0] === 'Closet');
    expect(rooms[laundry].slice(1)).toEqual([3, 'water']);
    expect(rooms[closet].slice(1)).toEqual([3, 'mold']);
    const cards = page.locator('#rooms .room');
    await expect(cards.nth(laundry).locator('.loss-tag')).toHaveText(['WATER · Cat 3']);
    await expect(cards.nth(closet).locator('.loss-tag')).toHaveText(['MOLD · Cat 3']);
    await expect(page.locator(sel(closet, 'loss')).locator('..')).toContainText('From walkthrough');
    await expect(page.locator(sel(closet, 'loss'))).toHaveValue('mold');
    await page.screenshot({ path: EV + 's2-fill-scope-phone.png', fullPage: true });
    await cards.nth(closet).screenshot({ path: EV + 's2-closet-mold-from-walkthrough.png' });
    // Undo beside Loss type restores the earlier explicit label, not a category-derived one.
    await page.locator(sel(closet, 'loss')).locator('..').getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator(sel(closet, 'loss'))).toHaveValue('water');
    await expect(page.locator('#rooms .room').nth(closet).locator('.loss-tag')).toHaveText(['WATER · Cat 3']);
    log('  after undo:', JSON.stringify(await page.evaluate(() => state.draft.data.rooms.map((r) => [r.name, r.category, r.loss]))));
    await page.locator('#rooms .room').nth(closet).screenshot({ path: EV + 's2-closet-after-undo.png' });
    await page.context().close();
  });

  await run('S3 adversarial: model loss "fire" is rejected and no scope is applied', async () => {
    await fetch(BASE + '/__lt/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":"bad"}' });
    const page = await newPage(browser, 'test-owner-lt-s3');
    await property(page);
    await page.locator('#technicianNotes').fill('Laundry is black water, category 3, no mold, 40 SF drywall. Closet has mold, 20 SF drywall.');
    const before = await page.evaluate(() => JSON.stringify(state.draft.data.rooms));
    page.on('response', async (r) => { if (r.url().includes('/api/')) log('  resp', r.request().method(), r.url().replace(BASE, ''), r.status()); });
    await page.locator('#fillScopeProperty').click();
    await page.waitForTimeout(4000);
    log('  status text:', await page.locator('#scopeSuggestionStatus').textContent().catch(() => ''), '| message:', await page.locator('#message').textContent().catch(() => ''));
    expect(await page.evaluate(() => JSON.stringify(state.draft.data.rooms))).toBe(before);
    await page.screenshot({ path: EV + 's3-bad-loss-rejected.png' });
    await fetch(BASE + '/__lt/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":"good"}' });
    // Direct save with an invalid loss is refused by the API.
    await saveDraft(page); await idle(page);
    const id = await page.evaluate(() => state.draft.inspection_id);
    const rec = await api(page, '/api/inspections/' + id);
    const data = rec.body.data; data.rooms[0].loss = 'fire';
    const put = await api(page, '/api/inspections/' + id, 'PUT', { expected_revision: rec.body.revision, data });
    log('  PUT loss=fire ->', put.status);
    expect(put.status).toBe(422);
    await page.context().close();
  });

  await run('S4 pricing comes from category only: cat-3 room priced the same as water, mold or both', async () => {
    const page = await newPage(browser, 'test-owner-lt-s4');
    await property(page);
    await page.locator(sel(0, 'name')).fill('Laundry');
    await page.locator(sel(0, 'category')).selectOption('3');
    await page.locator(sel(0, 'finished_sf')).fill('40');
    const ranges = {};
    for (const loss of ['water', 'mold', 'both']) {
      await page.locator('.task-nav [data-task="property"]').click();
      await page.locator(sel(0, 'loss')).selectOption(loss);
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(page.locator('#documents')).toBeVisible();
      ranges[loss] = [await page.locator('#estimateRange').textContent(), await page.evaluate(() => state.documents.xactimate_total)];
    }
    log('  ranges:', JSON.stringify(ranges));
    expect(ranges.mold).toEqual(ranges.water);
    expect(ranges.both).toEqual(ranges.water);
    await page.screenshot({ path: EV + 's4-pricing-proposal.png' });
    await page.context().close();
  });

  await run('S5 legacy unsigned draft (no loss) seeds once on open, then tag follows selector not category', async () => {
    const page = await newPage(browser, 'test-owner-lt-s5');
    await property(page);
    await page.locator(sel(0, 'name')).fill('Hall');
    await page.locator(sel(0, 'finished_sf')).fill('10');
    await page.locator('#addRoom').click();
    await page.locator(sel(1, 'name')).fill('Bath');
    await saveDraft(page); await idle(page);
    await page.evaluate(() => { for (const r of state.draft.data.rooms) delete r.loss; state.draft.data.rooms[1].category = 3; fillForm(); });
    await saveDraft(page); await idle(page);
    const id = await page.evaluate(() => state.draft.inspection_id);
    log('  stored before reopen:', JSON.stringify((await api(page, '/api/inspections/' + id)).body.data.rooms.map((r) => r.loss ?? null)));
    await page.reload();
    await expect(page.locator('#address')).toBeEnabled();
    await page.evaluate((i) => restoreDraft(i), id);
    await page.locator('.task-nav [data-task="property"]').click();
    await expect(page.locator(sel(1, 'loss'))).toHaveValue('mold');
    await expect(page.locator(sel(0, 'loss'))).toHaveValue('water');
    await idle(page);
    const stored = (await api(page, '/api/inspections/' + id)).body.data.rooms.map((r) => r.loss);
    log('  stored after reopen:', JSON.stringify(stored));
    expect(stored).toEqual(['water', 'mold']);
    await page.locator(sel(0, 'category')).selectOption('3');
    await expect(page.locator('#rooms .room').nth(0).locator('.loss-tag')).toHaveText(['WATER · Cat 3']);
    await page.locator('#rooms').screenshot({ path: EV + 's5-legacy-seeded.png' });
    await page.context().close();
  });

  await run('S6 office (read-only) opens audited legacy draft: no seeding, documents stay', async () => {
    await fetch(BASE + '/__test/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
    const id = 'ADR-INS-' + 'c'.repeat(32);
    const hdr = (role) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer test-owner-ws-' + role, 'X-ADR-Workspace-Protocol': '1' });
    const audit = await fetch(BASE + '/api/audit', { method: 'POST', headers: hdr('estimator'), body: JSON.stringify({ inspection_id: id, expected_revision: 1 }) });
    log('  estimator API audit', audit.status);
    expect(audit.status).toBe(200);
    const page = await newPage(browser, 'test-owner-ws-office');
    await page.goto(BASE + '/');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.locator('#dashboardJobs').click();
    await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await expect(page.locator('#address')).toBeDisabled();
    await expect(page.locator('#rooms .room .loss-tag')).toHaveText(['WATER · Cat 1']);
    const local = await page.evaluate(() => state.draft.data.rooms.map((r) => r.loss ?? null));
    log('  office local loss:', JSON.stringify(local), 'documents:', await page.evaluate(() => !!state.documents));
    expect(local).toEqual([null]);
    expect(await page.evaluate(() => !!state.documents)).toBe(true);
    await page.waitForTimeout(2500);
    const rec = await (await fetch(BASE + '/api/inspections/' + id, { headers: hdr('estimator') })).json();
    log('  server loss after office open:', JSON.stringify(rec.data.rooms.map((r) => r.loss ?? null)), 'revision', rec.revision);
    expect(rec.data.rooms[0].loss).toBeUndefined();
    await page.locator('[data-tab="proposal"]').click().catch(() => {});
    await page.screenshot({ path: EV + 's6-office-legacy-documents.png', fullPage: true });
    await page.context().close();
    await fetch(BASE + '/__test/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' });
  });

  await run('S7 signed legacy record keeps its old tag and is never re-saved with a loss', async () => {
    const page = await newPage(browser, 'test-owner-lt-s7');
    await property(page);
    await page.locator(sel(0, 'name')).fill('Bath');
    await page.locator(sel(0, 'category')).selectOption('3');
    await page.locator(sel(0, 'finished_sf')).fill('30');
    await page.evaluate(() => { delete state.draft.data.rooms[0].loss; });
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await expect(page.locator('#documents')).toBeVisible();
    const id = await page.evaluate(() => state.draft.inspection_id);
    expect((await api(page, '/api/inspections/' + id)).body.data.rooms[0].loss).toBeUndefined();
    await page.locator('#documentsConfirmed').check();
    const canvas = page.locator('#signCanvas');
    await canvas.scrollIntoViewIfNeeded();
    const rect = await canvas.boundingBox();
    await page.mouse.move(rect.x + 30, rect.y + 40); await page.mouse.down();
    await page.mouse.move(rect.x + 110, rect.y + 100, { steps: 8 }); await page.mouse.move(rect.x + 220, rect.y + 30, { steps: 8 }); await page.mouse.up();
    await page.locator('#authorizeJob').click();
    await expect(page.locator('#saveStatus')).toContainText('Saved & signed');
    await page.evaluate((i) => restoreDraft(i), id);
    await page.locator('.task-nav [data-task="property"]').click();
    await expect(page.locator('#rooms .room .loss-tag')).toHaveText(['MOLD · Cat 3']);
    await expect(page.locator(sel(0, 'loss'))).toBeDisabled();
    expect(await page.evaluate(() => state.draft.data.rooms[0].loss ?? null)).toBe(null);
    await page.waitForTimeout(2000);
    const rec = (await api(page, '/api/inspections/' + id)).body;
    log('  signed record loss:', rec.data.rooms[0].loss ?? null, 'status', rec.status);
    expect(rec.data.rooms[0].loss).toBeUndefined();
    await page.locator('#rooms').screenshot({ path: EV + 's7-signed-legacy.png' });
    await page.context().close();
  });

  await browser.close();
  log(JSON.stringify(results, null, 1));
})();
