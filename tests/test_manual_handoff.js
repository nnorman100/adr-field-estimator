/* Real Chrome context regression with synthetic, credential-free browser storage. */
const assert = require('node:assert/strict'),
  http = require('node:http'),
  fs = require('node:fs');
const { chromium } = require('@playwright/test');
const { launchManual, closeManual, sameContextPage } = require('../scripts/manual_chrome');
(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>ADR context regression</title><p>Synthetic storage only</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  let manual, browser;
  try {
    manual = await launchManual(url, 9338);
    browser = await chromium.connectOverCDP(manual.endpoint);
    const original = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith(url));
    await original.waitForLoadState('domcontentloaded');
    await original.evaluate(() =>
      localStorage.setItem('adr-context-regression', 'synthetic-marker'),
    );
    const wrong = await original.context().newPage();
    await wrong.goto(url);
    assert.equal(await wrong.evaluate(() => localStorage.getItem('adr-context-regression')), null);
    await wrong.close();
    const correct = await sameContextPage(browser, original);
    await correct.goto(url);
    assert.equal(
      await correct.evaluate(() => localStorage.getItem('adr-context-regression')),
      'synthetic-marker',
    );
    await original.close();
    assert.equal(
      await correct.evaluate(() => localStorage.getItem('adr-context-regression')),
      'synthetic-marker',
    );
    console.log(
      'PASS: reproduced default-tab isolation; explicit same-context tab retains synthetic private storage after original closes.',
    );
  } finally {
    await closeManual(browser, manual);
    await new Promise((resolve) => server.close(resolve));
    if (manual)
      assert(
        !fs.existsSync(manual.profile),
        'Owned temporary profile remained after browser shutdown',
      );
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
