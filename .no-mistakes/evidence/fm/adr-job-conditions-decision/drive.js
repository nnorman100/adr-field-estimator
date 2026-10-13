const { chromium } = require('playwright-core');
const fs = require('fs');
const BASE = 'http://localhost:8766';
const EV = process.argv[2];
const results = {};
const RETIRED = [/crawl space/i, /granite/i, /water heater/i, /Can Do Crew/i, /work was performed/i, /Technician reports this work/i];
const STD = {
  pretest: '(this does not include the pretest for lead/asbestos)',
  testing: "Testing is required under California State Law due to the home's construction year.",
  additional: 'If technicians encounter additional affected building materials beyond the quantities previously described',
  exclusionsTail: 'This estimate does not include testing of any kind.',
  reprice: 'If the work proceeds through an insurance claim, we will reprice the estimate according to industry standards using Xactimate.',
  validity: 'Estimate is valid for 30 days from date of inspection.',
  post1978: 'Therefore, no lead or asbestos testing is required prior to the start of work.',
};
function check(name, cond, detail) { results[name] = results[name] || []; results[name].push({ ok: !!cond, detail }); if (!cond) console.log('FAIL', name, detail); }
async function ready(page) {
  await page.goto(BASE + '/');
  await page.waitForFunction(() => !document.querySelector('#address')?.disabled, null, { timeout: 20000 });
}
async function fillScope(page, year, extra = {}) {
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('100 Synthetic Ln, Bakersfield, CA');
  await page.locator('#yearBuilt').fill(String(year));
  await page.locator('[data-room-key="finished_sf"]').first().fill('40');
  if (extra.notes) await page.locator('#technicianNotes').fill(extra.notes);
  await page.locator('#scopeConfirmed').check();
  await page.locator('#saveDraft').click();
  await page.locator('#saveStatus').filter({ hasText: 'Saved privately' }).waitFor();
}
async function api(page, path, method = 'GET', body) {
  return page.evaluate(async ([path, method, body]) => {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid') }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [path, method, body]);
}
async function docsText(page) {
  await page.locator('#documents').waitFor({ state: 'visible' });
  return page.evaluate(() => [...document.querySelectorAll('#documents article.doc')].map((a) => '=== ' + a.id + ' ===\n' + a.innerText.trim() + '\n' + (a.hidden ? a.textContent : '')).join('\n\n'));
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // S1: form no longer has the four checkboxes
  let page = await ctx.newPage();
  await ready(page);
  await page.locator('.task-nav [data-task="property"]').click();
  for (const label of ['Crawl space exists', 'Cabinet removal under granite', 'Garage water-heater loss', 'This scope has been performed'])
    check('S1 form checkboxes removed', (await page.getByText(label).count()) === 0, label);
  await page.screenshot({ path: EV + '/s1-property-form.png', fullPage: true });

  // S2: pre-1978 ADR documents with standard clauses
  await fillScope(page, 1960);
  await page.locator('#finishAudit').click();
  let text = await docsText(page);
  fs.writeFileSync(EV + '/s2-pre1978-documents.txt', text);
  for (const [k, v] of Object.entries(STD)) if (k !== 'post1978') check('S2 pre-1978 standard clauses', text.includes(v), k);
  check('S2 pre-1978 standard clauses', text.includes('Per IICRC and EPA protocols, Alert Disaster Restoration technicians will don appropriate personal protective equipment'), 'protection ADR');
  check('S2 pre-1978 standard clauses', text.includes('will NOT be the responsibility of Alert Disaster Restoration'), 'exclusions ADR');
  check('S2 pre-1978 standard clauses', text.includes('Due to property age (1960)'), 'age finding');
  check('S2 pre-1978 standard clauses', !text.includes(STD.post1978), 'no post1978 sentence');
  check('S2 pre-1978 standard clauses', text.includes('This scope describes proposed work'), 'proposed wording');
  await page.locator('#proposalBody').screenshot({ path: EV + '/s2-pre1978-proposal.png' });
  await page.locator('[data-tab="defense"]').click(); await page.locator('#doc-defense').screenshot({ path: EV + '/s2-pre1978-defense-letter.png' });
  await page.close();

  // S3: post-1978
  page = await ctx.newPage();
  await page.evaluate(() => 0);
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx2.newPage();
  await ready(page);
  await fillScope(page, 1995);
  await page.locator('#finishAudit').click();
  text = await docsText(page);
  fs.writeFileSync(EV + '/s3-post1978-documents.txt', text);
  check('S3 post-1978 sentence', text.includes('The home was built in 1995. ' + STD.post1978), 'post1978');
  check('S3 post-1978 sentence', !text.includes('configured ADR property-age rule') && !text.includes('No pre-testing is required'), 'old sentence gone');
  check('S3 post-1978 sentence', !text.includes(STD.testing) && !text.includes(STD.pretest), 'no pre-1978 testing text');
  for (const k of ['additional', 'exclusionsTail', 'reprice', 'validity']) check('S3 post-1978 sentence', text.includes(STD[k]), k);
  await page.locator('[data-tab="defense"]').click(); await page.locator('#doc-defense').screenshot({ path: EV + '/s3-post1978-defense-letter.png' });
  await ctx2.close();

  // S4 adversarial: older draft with retired flags all true
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx3.newPage();
  await ready(page);
  await fillScope(page, 1960);
  const rows = await api(page, '/api/inspections');
  const id = rows.body.inspections[0].inspection_id;
  const rec = (await api(page, '/api/inspections/' + id)).body;
  Object.assign(rec.data, { has_crawl_space: true, granite_removal: true, water_heater_loss: true, work_performed: true });
  const put = await api(page, '/api/inspections/' + id, 'PUT', { expected_revision: rec.revision, data: rec.data });
  check('S4 retired flags ignored', put.status === 200, 'PUT old flags accepted: ' + put.status);
  await page.reload();
  await page.locator('#restoreRemote').click();
  const reloaded = (await api(page, '/api/inspections/' + id)).body;
  check('S4 retired flags ignored', reloaded.data.granite_removal === true, 'server keeps legacy value for old drafts');
  await page.locator('#finishAudit').click();
  text = await docsText(page);
  fs.writeFileSync(EV + '/s4-legacy-flags-documents.txt', text);
  for (const re of RETIRED) check('S4 retired flags ignored', !re.test(text), 'absent ' + re);
  check('S4 retired flags ignored', text.includes('This scope describes proposed work; completion has not been recorded.'), 'proposed wording despite work_performed');
  check('S4 retired flags ignored', text.includes(STD.validity), 'validity');
  await page.locator('#documents').screenshot({ path: EV + '/s4-legacy-flags-documents.png' });

  // S5: AI scope suggestions no longer offer retired fields; a model returning them is rejected
  const notes = 'Room 1, category 2, 80 square feet of drywall. Use 3 fans. Kitchen cabinets come out under the granite. There is a crawl space. Garage water heater leaked.';
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#technicianNotes').fill(notes);
  await page.locator('#saveDraft').click();
  await page.locator('#saveStatus').filter({ hasText: 'Saved privately' }).waitFor();
  let r2 = (await api(page, '/api/inspections/' + id)).body;
  const sug = await api(page, `/api/inspections/${id}/scope-suggestions`, 'POST', { inspection_id: id, expected_revision: r2.revision });
  const probe = await (await fetch(BASE + '/__probe/scope')).json();
  const enumFields = probe.schema.properties.changes.items.properties.field.enum;
  fs.writeFileSync(EV + '/s5-scope-wire-schema-and-prompt.json', JSON.stringify({ suggestionStatus: sug.status, enumFields, prompt: probe.prompt }, null, 2));
  for (const f of ['has_crawl_space', 'granite_removal', 'water_heater_loss', 'work_performed']) check('S5 scope suggestions', !enumFields.includes(f), 'schema enum excludes ' + f);
  check('S5 scope suggestions', !/granite_removal|has_crawl_space|water_heater_loss|granite flag/.test(JSON.parse(probe.prompt)[0].split('\n{')[0]), 'prompt has no retired field instructions');
  check('S5 scope suggestions', sug.status === 200, 'normal suggestions still work: ' + sug.status);
  await fetch(BASE + '/__probe/retired', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
  const bad = await api(page, `/api/inspections/${id}/scope-suggestions`, 'POST', { inspection_id: id, expected_revision: r2.revision });
  fs.writeFileSync(EV + '/s5-model-returns-retired-fields.json', JSON.stringify(bad, null, 2));
  check('S5 scope suggestions', bad.status === 502, 'model-returned retired fields rejected: ' + bad.status + ' ' + JSON.stringify(bad.body));
  await fetch(BASE + '/__probe/retired', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
  // UI path: Fill scope shows only allowed fields
  await page.locator('#fillScopeProperty').click();
  await page.locator('#scopeSuggestionPanel').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  const panel = await page.locator('#scopeSuggestionPanel').innerText();
  for (const l of ['Crawl space', 'granite', 'water-heater']) check('S5 scope suggestions', !panel.includes(l), 'panel lacks ' + l);
  await page.locator('#scopeSuggestionPanel').screenshot({ path: EV + '/s5-scope-suggestions-panel.png' });
  await ctx3.close();

  // S6: non-ADR company (workspaces) — company name in clauses, stored water-heater notice not printed, profile form has no field
  await fetch(BASE + '/__test/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx4.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-other'));
  page = await ctx4.newPage();
  page.on('pageerror', (e) => check('S6 other company', false, 'pageerror ' + e.message));
  await page.goto(BASE + '/');
  await page.locator('#workspaceDashboard').waitFor({ state: 'visible' });
  const hdr = { Authorization: 'Bearer test-owner-ws-other', 'X-ADR-Workspace-Protocol': '1', 'Content-Type': 'application/json' };
  const wsapi = async (path, method = 'GET', body) => { const r = await fetch(BASE + path, { method, headers: hdr, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  fs.writeFileSync(EV + '/s6-dashboard-dom.txt', await page.locator('#workspaceDashboard').innerText());
  await page.screenshot({ path: EV + '/s6-other-dashboard.png', fullPage: true });
  // Company profile form
  const btns = await page.locator('#workspaceDashboard button').allInnerTexts();
  fs.writeFileSync(EV + '/s6-buttons.txt', btns.join('\n'));
  await ctx4.close();
  await browser.close();
  fs.writeFileSync(EV + '/scenario-results.json', JSON.stringify(results, null, 2));
  const failed = Object.values(results).flat().filter((x) => !x.ok).length;
  console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.every((x) => x.ok) ? 'pass' : 'FAIL']))), 'failed checks:', failed);
})().catch((e) => { console.error(e); process.exit(1); });
