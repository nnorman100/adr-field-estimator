const { test, expect } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M58A3J8XFY00TDSWMDSC3X2Y/node_modules/@playwright/test');
const E = '/home/nnorm/.no-mistakes/evidence/01M58A3J8XFY00TDSWMDSC3X2Y/';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
async function open(page) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
}
async function addImage(page, name) {
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 400;
    const g = c.getContext('2d'); g.fillStyle = '#4a7'; g.fillRect(0, 0, 300, 400); return c.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(image.split(',')[1], 'base64') });
}
async function rename(page, name) {
  const box = page.locator('#roomChips .room-chip-input');
  await box.fill(name); await box.press('Enter'); await expect(box).toHaveCount(0);
}
const settled = (page) => page.evaluate(async () => { await syncChain.catch(() => {}); await Promise.all([...state.ocr.values()]); return state.record.photos.map((p) => p.room); });

test('walk & photo visual flow, check scope room cards, disclosure', async ({ page }) => {
  await open(page);
  await page.screenshot({ path: E + '01-new-job-opens-walk-and-photo.png' });
  await expect(page.locator('#technicianTranscript')).toBeHidden();
  await expect(page.locator('#thermalToggle')).toBeHidden();
  await page.locator('#roomChips button', { hasText: 'Room 1' }).click();
  await rename(page, 'Kitchen');
  await addImage(page, 'k.png');
  await page.locator('#addRoomChip').click();
  await rename(page, 'Hallway');
  await addImage(page, 'h.png');
  await expect.poll(() => settled(page)).toEqual(['Kitchen', 'Hallway']);
  await page.locator('.photo-strip').scrollIntoViewIfNeeded();
  await page.screenshot({ path: E + '02-walk-photo-chips-and-photo-strip.png', fullPage: true });
  await page.locator('#panel-walkthrough .capture-options summary').click();
  await expect(page.locator('#technicianTranscript')).toBeVisible();
  await expect(page.locator('#thermalToggle')).toBeVisible();
  await page.locator('#panel-walkthrough .capture-options').scrollIntoViewIfNeeded();
  await page.screenshot({ path: E + '03-more-walkthrough-options-open.png' });
  await page.locator('#technicianTranscript').fill('Kitchen, category 2, 80 SF drywall. Use 3 fans.');
  expect(await page.evaluate(() => ui.task)).toBe('walkthrough');
  await page.locator('#fillScope').click();
  await expect(page.locator('#panel-property')).toBeVisible();
  const cards = page.locator('#rooms .room');
  await expect(cards.nth(0).locator('.room-photos .photo strong')).toHaveText(['Kitchen']);
  await expect(cards.nth(1).locator('.room-photos .photo strong')).toHaveText(['Hallway']);
  await page.locator('#rooms').scrollIntoViewIfNeeded();
  await page.screenshot({ path: E + '04-check-scope-room-cards-with-photos.png', fullPage: true });
});

test('desk estimate: one tap from a new job to Check Scope', async ({ page }) => {
  await open(page);
  await expect(page.locator('#panel-walkthrough')).toBeVisible();
  await page.locator('.task-nav [data-task="property"]').click();
  await expect(page.locator('#panel-property')).toBeVisible();
  await expect(page.locator('#panel-walkthrough')).toBeHidden();
  await expect(page.locator('#address')).toBeEditable();
  await page.screenshot({ path: E + '05-desk-estimate-check-scope.png' });
});

test('offline notes mode keeps Capture photo and it saves a photo', async ({ page }) => {
  await open(page);
  await page.locator('#startNotes').click();
  await expect(page.locator('#offlineNotes')).toBeVisible();
  await expect(page.locator('#takePhoto')).toBeVisible();
  await expect(page.locator('#takePhoto')).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#takePhoto').click();
  const fc = await chooser;
  expect(fc.isMultiple()).toBe(false);
  expect(await fc.element().getAttribute('capture')).toBe('environment');
  await addImage(page, 'offline.png');
  await expect(page.locator('#photoGallery .photo')).toHaveCount(1);
  await page.screenshot({ path: E + '06-offline-notes-capture-photo.png', fullPage: true });
});

test('capture photo while Live runs grabs a frame (no file chooser)', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const videoTracks = canvas.captureStream(1).getVideoTracks();
    const g = canvas.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 640, 480);
    setInterval(() => { g.fillRect(0, 0, 640, 480); }, 200);
    const audio = new AudioContext(), dest = audio.createMediaStreamDestination();
    window.syntheticTracks = [...videoTracks, ...dest.stream.getAudioTracks()];
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => new MediaStream(window.syntheticTracks) } });
    window.WebSocket = class { static OPEN = 1; readyState = 0; bufferedAmount = 0;
      constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(m) { if (JSON.parse(m).type === 'authenticate') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }), 0); }
      close() { this.readyState = 3; this.onclose?.(); } };
  });
  await page.locator('#startWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
  let chooserOpened = false;
  page.on('filechooser', () => (chooserOpened = true));
  await page.locator('#takePhoto').click();
  await expect(page.locator('#photoGallery .photo')).toHaveCount(1, { timeout: 15000 });
  expect(chooserOpened).toBe(false);
  await page.screenshot({ path: E + '07-live-capture-frame.png', fullPage: true });
  await page.locator('#stopWalk').click();
});
