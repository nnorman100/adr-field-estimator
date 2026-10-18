// Disposable live driver for the per-room loss type (branding PR 6b). Local synthetic server only.
const W = '/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M58KZ2JDGSYGW2QGV0A1XV0R';
const { chromium } = require(W + '/node_modules/playwright');
const EV = '/home/nnorm/.no-mistakes/evidence/01M58KZ2JDGSYGW2QGV0A1XV0R';
const BASE = 'https://localhost:8890';
const log = [];
const results = {};
function note(...a) {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  log.push(s);
  console.log(s);
}
function check(name, ok, detail) {
  results[name] = results[name] === false ? false : !!ok;
  note((ok ? 'PASS ' : 'FAIL ') + name, detail ?? '');
}
const sel = (i, k) => `[data-room-index="${i}"][data-room-key="${k}"]`;
async function tags(page, i) {
  return page.locator('#rooms .room').nth(i).locator('.loss-tag').allInnerTexts();
}
async function idle(page) {
  await page.waitForTimeout(1900);
  await page.evaluate(async () => {
    await syncChain.catch(() => {});
  });
  for (let i = 0; i < 50 && (await page.evaluate(() => state.syncing)); i++)
    await page.waitForTimeout(100);
}
async function saveDraft(page) {
  const menu = page.locator('#jobMenu');
  if (!(await menu.evaluate((el) => el.open))) await menu.locator('summary').click();
  await page.locator('#saveDraft').click();
  await page.locator('#saveStatus').filter({ hasText: 'Saved privately' }).waitFor();
}
async function fresh(browser, uid) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => note('PAGEERROR', e.message));
  if (uid) await page.addInitScript((v) => sessionStorage.setItem('synthetic-uid', v), uid);
  await page.goto(BASE + '/');
  return { ctx, page };
}
async function jobs(page) {
  await page.locator('#workspaceNav').waitFor({ state: 'visible' });
  const toggle = page.locator('#workspaceMenuToggle');
  if (await toggle.isVisible()) await toggle.click();
  await page.locator('#dashboardJobs').click();
}
async function property(page, notes) {
  await page.locator('#address').waitFor();
  await page.locator('#address').fill('Synthetic loss-type property');
  await page.locator('#yearBuilt').fill('1998');
  if (notes) await page.locator('#technicianNotes').fill(notes);
}

(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });

  // S1: manual loss type beside the category; category 3 black water without mold stays WATER.
  {
    const { ctx, page } = await fresh(browser);
    await property(page);
    await page.locator(sel(0, 'name')).fill('Bathroom');
    await page.locator(sel(0, 'finished_sf')).fill('40');
    const opts = await page.locator(sel(0, 'loss') + ' option').allInnerTexts();
    check('S1 loss selector offers Water / Mold / Water and mold', JSON.stringify(opts) === JSON.stringify(['Water', 'Mold', 'Water and mold']), opts);
    check('S1 new room defaults to water', (await page.locator(sel(0, 'loss')).inputValue()) === 'water');
    await page.locator(sel(0, 'category')).selectOption('3');
    const t = await tags(page, 0);
    check('S1 category 3 without mold tagged WATER', JSON.stringify(t) === '["WATER · Cat 3"]', t);
    await page.locator('#rooms .room').nth(0).screenshot({ path: EV + '/s1-cat3-black-water-tag-water.png' });
    await page.locator(sel(0, 'loss')).selectOption('both');
    const t2 = await tags(page, 0);
    check('S1 both shows WATER and MOLD tags', JSON.stringify(t2) === '["WATER · Cat 3","MOLD · Cat 3"]', t2);
    await page.locator('#rooms .room').nth(0).screenshot({ path: EV + '/s1-loss-both-two-tags.png' });

    // S3: label only, pricing keeps coming from category.
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await page.locator('#documents').waitFor({ state: 'visible' });
    const rangeBoth = await page.locator('#estimateRange').innerText();
    const reviewBoth = await page.locator('#reviewRooms .loss-tag').allInnerTexts();
    note('S3 range with loss=both', rangeBoth, reviewBoth);
    await page.screenshot({ path: EV + '/s3-review-loss-both.png', fullPage: false });
    await page.locator('#reviewRooms').screenshot({ path: EV + '/s3-review-room-chips-both.png' });
    await page.locator('.task-nav [data-task="property"]').click();
    await page.locator(sel(0, 'loss')).selectOption('water');
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await page.locator('#documents').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#reviewRooms .loss-tag')?.innerText.includes('WATER'));
    const rangeWater = await page.locator('#estimateRange').innerText();
    const docsText = await page.locator('#documents').innerText();
    note('S3 range with loss=water', rangeWater);
    check('S3 estimate range identical for water vs both at category 3', rangeBoth === rangeWater && /\$/.test(rangeWater), { rangeBoth, rangeWater });
    check('S3 documents still price by category 3', docsText.includes('category 3 finished/drywall/trim demolition'));
    const saved = await page.evaluate(async () => (await jsonApi('/api/inspections/' + state.draft.inspection_id)).data.rooms[0]);
    check('S3 server saved explicit loss and category', saved.loss === 'water' && saved.category === 3, saved);
    await ctx.close();
  }

  // S2: Fill scope sets the loss type from the walkthrough's "water, mold, or both" answer.
  for (const [quote, loss, want] of [
    ['Room 1 is black water, category 3, water only, 40 SF drywall.', 'water', '["WATER · Cat 3"]'],
    ['Room 1 has water and mold, category 3, 40 SF drywall.', 'both', '["WATER · Cat 3","MOLD · Cat 3"]'],
  ]) {
    const { ctx, page } = await fresh(browser);
    await property(page, quote);
    // Start from the opposite label so the walkthrough answer must change it.
    await page.locator(sel(0, 'loss')).selectOption(loss === 'water' ? 'mold' : 'water');
    await page.locator('#fillScopeProperty').click();
    await page.locator('#scopeSuggestionPanel').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[data-room-key="category"]').value === '3');
    const v = await page.locator(sel(0, 'loss')).inputValue();
    const t = await tags(page, 0);
    const lbl = await page.locator(sel(0, 'loss')).locator('..').innerText();
    const panel = await page.locator('#scopeSuggestionPanel').innerText();
    check(`S2 Fill scope sets loss=${loss}`, v === loss && JSON.stringify(t) === want && lbl.includes('From walkthrough'), { v, t, lbl });
    note('S2 suggestion panel', panel.replace(/\s+/g, ' ').slice(0, 300));
    await page.screenshot({ path: EV + `/s2-fill-scope-loss-${loss}.png` });
    await page.locator('#rooms .room').nth(0).screenshot({ path: EV + `/s2-fill-scope-room-${loss}.png` });
    await ctx.close();
  }

  // S4: legacy unsigned draft (no loss) seeds on open; Fill scope then Undo restores the seeded label.
  {
    const { ctx, page } = await fresh(browser);
    await property(page, 'Room 1 has water and mold, category 3, 40 SF drywall.');
    await page.locator(sel(0, 'finished_sf')).fill('10');
    await saveDraft(page);
    await idle(page);
    await page.evaluate(() => {
      delete state.draft.data.rooms[0].loss;
      state.draft.data.rooms[0].category = 1;
      fillForm();
    });
    await saveDraft(page);
    await idle(page);
    const before = await page.evaluate(async () => (await jsonApi('/api/inspections/' + state.draft.inspection_id)).data.rooms[0].loss);
    check('S4 legacy room stored without loss', before === undefined, before);
    await page.evaluate(() => restoreDraft(state.draft.inspection_id));
    await idle(page);
    const seeded = await page.locator(sel(0, 'loss')).inputValue();
    const after = await page.evaluate(async () => (await jsonApi('/api/inspections/' + state.draft.inspection_id)).data.rooms[0].loss);
    check('S4 opening editable legacy draft seeds water and saves it', seeded === 'water' && after === 'water', { seeded, after });
    await page.locator('#fillScopeProperty').click();
    await page.waitForFunction(() => document.querySelector('[data-room-key="loss"]').value === 'both');
    await page.locator(sel(0, 'loss')).locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
    const undone = await page.locator(sel(0, 'loss')).inputValue();
    const t = await tags(page, 0);
    const cat = await page.locator(sel(0, 'category')).inputValue();
    check('S4 Undo on loss restores seeded WATER even with category 3', undone === 'water' && cat === '3' && JSON.stringify(t) === '["WATER · Cat 3"]', { undone, cat, t });
    await page.locator('#rooms .room').nth(0).screenshot({ path: EV + '/s4-legacy-undo-restores-seeded-water.png' });
    await ctx.close();
  }

  // S5: read-only office user opening an audited legacy draft neither seeds nor loses documents.
  {
    const req = await browser.newContext({ ignoreHTTPSErrors: true });
    const r = await (await req.request.post(BASE + '/__test/workspaces', { data: { enabled: true } })).json();
    const id = r.inspection_id;
    const est = await fresh(browser, 'test-owner-ws-estimator');
    await est.page.locator('#workspaceDashboard').waitFor({ state: 'visible' });
    await jobs(est.page);
    await est.page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await est.page.locator('#address').waitFor();
    await idle(est.page);
    // Return the job to its pre-loss-type shape (category 3, no loss) and audit it as such.
    await est.page.evaluate(() => {
      delete state.draft.data.rooms[0].loss;
      state.draft.data.rooms[0].category = 3;
      fillForm();
    });
    await est.page.locator('#scopeConfirmed').check();
    await est.page.locator('#finishAudit').click();
    await est.page.locator('#documents').waitFor({ state: 'visible' });
    await idle(est.page);
    const auth = { Authorization: 'Bearer test-owner-ws-estimator', 'X-ADR-Workspace-Protocol': '1' };
    const getRec = async () => (await (await req.request.get(BASE + '/api/inspections/' + id, { headers: auth })).json());
    const rec1 = await getRec();
    note('S5 audited legacy record', { revision: rec1.revision, loss: rec1.data?.rooms?.[0]?.loss, audit: !!rec1.audit });
    await est.ctx.close();
    const off = await fresh(browser, 'test-owner-ws-office');
    await off.page.locator('#workspaceDashboard').waitFor({ state: 'visible' });
    await jobs(off.page);
    await off.page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await off.page.locator('#address').waitFor();
    await idle(off.page);
    const st = await off.page.evaluate(() => ({ loss: state.draft.data.rooms[0].loss, docs: !!state.documents, disabled: $('address').disabled, finish: $('finishAudit').disabled, canScope: WorkspaceUI.can('scope'), role: WorkspaceUI.session?.()?.role }));
    const t = await tags(off.page, 0);
    const docVisible = await off.page.locator('#proposalBody').innerText();
    const rec2 = await getRec();
    check('S5 office open leaves loss unseeded, keeps documents, no save', rec1.audit && st.loss === undefined && st.docs && st.canScope === false && rec2.revision === rec1.revision && rec2.data.rooms[0].loss === undefined && docVisible.trim().length > 0, { st, t, rev: [rec1.revision, rec2.revision], doc: docVisible.slice(0, 80) });
    check('S5 office sees display-only legacy tag MOLD · Cat 3', JSON.stringify(t) === '["MOLD · Cat 3"]', t);
    await off.page.screenshot({ path: EV + '/s5-office-legacy-audited-draft.png' });
    await off.ctx.close();
    await req.request.post(BASE + '/__test/workspaces', { data: { enabled: false } });
    await req.close();
  }

  await browser.close();
  require('fs').writeFileSync(EV + '/live-driver-transcript.txt', log.join('\n') + '\n');
  console.log(JSON.stringify(results, null, 1));
})().catch((e) => {
  console.error(e);
  require('fs').writeFileSync(EV + '/live-driver-transcript.txt', log.join('\n') + '\nERROR ' + e.stack + '\n');
  process.exit(1);
});
