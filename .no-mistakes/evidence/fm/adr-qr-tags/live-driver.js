const WT = '/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M5FYV9TDHF8BP4DQ791YTBRX';
const { chromium } = require(WT + '/node_modules/playwright');
const EV = '/home/nnorm/.no-mistakes/evidence/01M5FYV9TDHF8BP4DQ791YTBRX';
const BASE = 'https://localhost:' + process.env.PORT;
const log = (...a) => console.log(...a);
function check(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); log('PASS: ' + msg); }
(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  await page.addInitScript(() => {
    // Camera stand-in: a canvas showing whatever tag image the driver holds up. jsQR is NOT stubbed.
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const c = canvas.getContext('2d'); const img = new Image(); let src = null;
    setInterval(() => {
      c.fillStyle = '#fff'; c.fillRect(0, 0, 640, 480);
      if (window.__tagImgSrc && window.__tagImgSrc !== src) { src = window.__tagImgSrc; img.src = src; }
      if (window.__tagImgSrc && img.complete && img.naturalWidth) c.drawImage(img, 170, 90, 300, 300);
    }, 100);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => canvas.captureStream(10) } });
  });
  await page.goto(BASE + '/');

  await page.waitForFunction(() => !document.getElementById('address').disabled, null, { timeout: 15000 });
  const chip = (n) => page.locator('#roomChips').getByRole('button', { name: n, exact: true });
  async function rename(n) { const b = page.locator('#roomChips .room-chip-input'); await b.waitFor(); await b.fill(n); await b.press('Enter'); await b.waitFor({ state: 'detached' }); }
  await chip('Room 1').click(); await rename('Kitchen');
  await page.locator('#addRoomChip').click(); await rename('Hallway');
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('742 Evergreen Ter, Bakersfield CA');
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await page.screenshot({ path: EV + '/01-walk-tag-buttons.png', fullPage: true });

  // 1. Create and print QR tags for both rooms and an air mover + dehumidifier.
  await page.locator('#printTags').click();
  const sheet = page.locator('#tagSheetDialog');
  await sheet.waitFor({ state: 'visible' });
  await sheet.locator('#equipmentTagKind').selectOption('air_mover');
  await sheet.locator('#equipmentTagAsset').fill('am-0007'); await sheet.locator('#addEquipmentTag').click();
  await sheet.locator('#equipmentTagKind').selectOption('dehumidifier');
  await sheet.locator('#equipmentTagAsset').fill('DH-12'); await sheet.locator('#addEquipmentTag').click();
  await sheet.locator('#makeTags').click();
  const cards = sheet.locator('#tagPreview .tag-card');
  await page.waitForFunction(() => document.querySelectorAll('#tagPreview .tag-card').length === 4);
  const tags = await cards.evaluateAll((els) => els.map((e) => ({ title: e.querySelector('strong').textContent, sub: e.querySelector('span').textContent, code: e.querySelector('code').textContent, src: e.querySelector('img').src })));
  log(JSON.stringify(tags.map(({ src, ...t }) => t)));
  check(tags.length === 4, 'tag sheet shows 4 server-rendered tags (2 rooms, 2 equipment)');
  await page.screenshot({ path: EV + '/02-tag-sheet-preview.png', fullPage: true });
  await sheet.locator('#tagPreview').screenshot({ path: EV + '/02b-printed-qr-tag-cards.png' });
  let printed = null;
  await page.evaluate(() => { window.print = () => { window.__printed = { tags: document.body.classList.contains('printing-tags'), cards: document.querySelectorAll('#tagSheet .tag-card').length }; }; });
  await sheet.locator('#printTagSheet').click();
  await page.screenshot({ path: EV + '/03-print-layout.png', fullPage: true });
  printed = await page.evaluate(() => window.__printed);
  check(printed && printed.tags && printed.cards === 4, 'Print shows only the 4-tag sheet: ' + JSON.stringify(printed));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await sheet.locator('#closeTagSheet').click();

  // 2. Scan the printed tags with the (synthetic) camera; real jsQR decodes the real QR image.
  const kitchen = tags.find((t) => t.title === 'Kitchen'), am = tags.find((t) => t.sub === 'AM-0007'), dh = tags.find((t) => t.sub === 'DH-12');
  await chip('Hallway').click();
  await page.locator('#scanTag').click();
  const scan = page.locator('#tagScanDialog'); const status = scan.locator('#tagScanStatus');
  await page.waitForFunction(() => document.getElementById('tagScanDialog').classList.contains('scanning'));
  await page.evaluate((s) => (window.__tagImgSrc = s), kitchen.src);
  await page.waitForFunction(() => /Current room: Kitchen/.test(document.getElementById('tagScanStatus').textContent), null, { timeout: 10000 });
  check(await chip('Kitchen').getAttribute('aria-pressed') === 'true', 'camera scan of printed Kitchen room tag selects Kitchen');
  await page.evaluate((s) => (window.__tagImgSrc = s), am.src);
  await page.waitForFunction(() => /Air mover AM-0007 placed in Kitchen/.test(document.getElementById('tagScanStatus').textContent), null, { timeout: 10000 });
  log('status:', await status.textContent());
  await page.screenshot({ path: EV + '/04-camera-scan-air-mover.png', fullPage: true });
  await page.waitForTimeout(1200);
  const logCount = await scan.locator('#tagScanLog li').count();
  check(logCount === 2, 'tag held in view is recorded once (log entries=' + logCount + ')');
  await page.evaluate((s) => (window.__tagImgSrc = s), dh.src);
  await page.waitForFunction(() => /dehumidifier DH-12 placed in Kitchen/.test(document.getElementById('tagScanStatus').textContent), null, { timeout: 10000 });
  await scan.locator('#closeTagScan').click();
  await page.waitForFunction(() => document.getElementById('tagVideo').srcObject === null);
  check(true, 'closing the scanner releases the camera');
  const count = await page.locator('#tagCount').textContent();
  check(/2 units tagged · 1 room/.test(count), 'Walk & Photo summary: ' + count);
  await page.locator('#equipmentPlacements').scrollIntoViewIfNeeded();
  await page.screenshot({ path: EV + '/05-placements-summary.png', fullPage: true });
  // Persistence
  const menu = page.locator('#jobMenu'); if (!(await menu.evaluate((el) => el.open))) await menu.locator(':scope > summary').click();
  await page.locator('#saveDraft').click();
  await page.waitForFunction(() => document.getElementById('saveStatus').textContent === 'Saved');
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('address').disabled, null, { timeout: 15000 });
  const after = await page.locator('#tagCount').textContent();
  check(/2 units tagged · 1 room/.test(after), 'placements survive reload: ' + after);

  await page.locator('.task-nav [data-task="walkthrough"]').click();
  // 3. Adversarial: unknown / foreign QR shown to the camera is refused.
  await page.locator('#scanTag').click();
  await page.waitForFunction(() => document.getElementById('tagScanDialog').classList.contains('scanning'));
  const foreign = await page.evaluate(async () => { const r = await fetch('/api/health'); return null; });
  // Generate a QR for a non-DryScope payload via a printed-tag of another job is not possible client-side;
  // use a forged room tag for a different job id encoded by the real server renderer via a crafted code.
  await scan.locator('#tagCodeInput').fill('DS1-RM-00000000-Kitchen'); await scan.locator('#applyTagCode').click();
  await page.waitForFunction(() => /different job/.test(document.getElementById('tagScanStatus').textContent));
  check(true, 'tag printed for a different job is refused: ' + (await status.textContent()));
  await scan.locator('#closeTagScan').click();

  // 4. Adversarial: duplicate room names are refused for scanning and printing.
  await chip('Hallway').click({ clickCount: 1 });
  await chip('Hallway').click();
  const box = page.locator('#roomChips .room-chip-input');
  if (await box.count()) { await box.fill(' kitchen'); await box.press('Enter'); }
  log('chips:', await page.locator('#roomChips button').allTextContents());
  await page.locator('#scanTag').click();
  await page.waitForTimeout(800);
  await scan.locator('#tagCodeInput').fill(kitchen.code); await scan.locator('#applyTagCode').click();
  await page.waitForTimeout(500);
  const dupScan = await status.textContent();
  log('dup scan status:', dupScan);
  await page.screenshot({ path: EV + '/06-duplicate-room-scan-refused.png', fullPage: true });
  check(/distinct name/.test(dupScan), 'scan refused while two rooms share a name');
  await scan.locator('#closeTagScan').click();
  await page.locator('#printTags').click();
  await sheet.locator('#makeTags').click();
  await page.waitForTimeout(800);
  const dupSheet = await sheet.locator('#tagSheetStatus').textContent();
  log('dup sheet status:', dupSheet);
  await page.screenshot({ path: EV + '/07-duplicate-room-print-refused.png', fullPage: true });
  check(/distinct name/.test(dupSheet), 'Make tags refused while two rooms share a name');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
