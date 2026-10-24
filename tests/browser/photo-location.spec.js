const { test, expect } = require('@playwright/test');
const { saveDraft, checkScope } = require('./actions');

// Photo location stamps against the synthetic backend; the position is emulated, not a phone's GPS.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
test.afterEach(async ({ page }, info) => {
  await page.screenshot({ path: info.outputPath('photo-location-full-page.png'), fullPage: true });
});

const FIX = { latitude: 35.373292, longitude: -119.018712, accuracy: 12 };
async function open(page) {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function addImage(page) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 300;
    canvas.getContext('2d').fillRect(0, 0, 100, 150);
    return canvas.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({
    name: 'room.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
}
async function finish(page) {
  await checkScope(page);
  await page.locator('#address').fill('Synthetic browser property');
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await page.locator('[data-tab=photos]').click();
}
const settled = (page) =>
  page.evaluate(async () => {
    await syncChain.catch(() => {});
    await Promise.all([...state.ocr.values()]);
    return state.record.photos.map((photo) => photo.location);
  });

test('a photo is stamped with the device location and the photo log links it on a map', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(FIX);
  await open(page);
  await addImage(page);
  await expect(page.locator('#photoGallery')).toContainText(
    'Location: 35.373292, -119.018712 (±12 m) · source: device',
  );
  expect(await settled(page)).toEqual([
    { source: 'device', latitude: 35.373292, longitude: -119.018712, accuracy_m: 12 },
  ]);
  await finish(page);
  const entry = page.locator('#photoAuditLog .audit-photo');
  await expect(entry).toContainText('Location: 35.373292, -119.018712 (±12 m) · source: device');
  const link = entry.getByRole('link', { name: 'Open in Google Maps' });
  await expect(link).toHaveAttribute(
    'href',
    'https://www.google.com/maps/search/?api=1&query=35.373292,-119.018712',
  );
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('a refused location still saves the photo and says the location was not shared', async ({
  page,
  context,
}) => {
  await context.clearPermissions();
  await open(page);
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (ok, fail) => fail({ code: 1 });
  });
  await addImage(page);
  await expect(page.locator('#photoGallery')).toContainText('Location not shared');
  expect(await settled(page)).toEqual([{ source: 'not_shared' }]);
  await finish(page);
  const entry = page.locator('#photoAuditLog .audit-photo');
  await expect(entry).toContainText('Location not shared');
  await expect(entry.getByRole('link', { name: 'Open in Google Maps' })).toHaveCount(0);
});

test('a photo taken with no signal keeps its location on the phone and uploads it after reconnecting', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(FIX);
  await open(page);
  await context.setOffline(true);
  await addImage(page);
  await expect(page.locator('#photoGallery')).toContainText('source: device');
  await expect(page.locator('#saveStatus')).toHaveText('Offline · saved on phone');
  await context.setOffline(false);
  await page.evaluate(() => syncDraft());
  await expect
    .poll(() => settled(page))
    .toEqual([{ source: 'device', latitude: 35.373292, longitude: -119.018712, accuracy_m: 12 }]);
});

test('a photo saved before location stamps reads No location recorded', async ({ page }) => {
  await open(page);
  const uid = await page.evaluate(() => sessionStorage.getItem('synthetic-uid'));
  const id = await page.evaluate(() => state.draft.inspection_id);
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    return canvas.toDataURL('image/png');
  });
  const record = await (
    await page.request.get('/api/inspections/' + id, {
      headers: { Authorization: 'Bearer ' + uid },
    })
  ).json();
  const saved = await page.request.post('/api/inspections/' + id + '/photos', {
    headers: { Authorization: 'Bearer ' + uid },
    data: {
      expected_revision: record.revision,
      photo_id: 'a'.repeat(32),
      room: record.data.rooms[0]?.name || 'Bathroom',
      captured_at: '2026-10-06T19:00:00Z',
      data_url: image,
    },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await expect(page.locator('#photoGallery')).toContainText('No location recorded');
});

for (const transition of ['new', 'restore']) {
  test(
    'a delayed location preserves the originating photo before ' + transition,
    async ({ page, context }) => {
      await open(page);
      await context.setOffline(true);
      const origin = await page.evaluate(() => {
        navigator.geolocation.getCurrentPosition = (ok) => {
          window.finishLocation = () =>
            ok({ coords: { latitude: 35, longitude: -119, accuracy: 5 } });
        };
        return state.draft.inspection_id;
      });
      await addImage(page);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const rows = await localDrafts();
            return rows.some((row) => row.draft.photos.length === 1);
          }),
        )
        .toBe(true);
      await page.evaluate((kind) => {
        window.photoTransitionDone = false;
        window.photoTransition = (
          kind === 'new' ? openNew() : restoreDraft(state.draft.inspection_id)
        ).then(() => {
          window.photoTransitionDone = true;
        });
      }, transition);
      expect(await page.evaluate(() => window.photoTransitionDone)).toBe(false);
      await page.evaluate(() => window.finishLocation());
      await page.evaluate(() => window.photoTransition);
      await page.evaluate((id) => restoreDraft(id), origin);
      await expect(page.locator('#photoGallery')).toContainText('source: device');
      expect(await page.evaluate(() => state.draft.photos.length)).toBe(1);
    },
  );
}

test('forking a conflicted draft waits for the photo location before copying evidence', async ({
  page,
  context,
}) => {
  await open(page);
  await context.setOffline(true);
  const original = await page.evaluate(() => {
    state.conflict = true;
    document.getElementById('conflictActions').hidden = false;
    navigator.geolocation.getCurrentPosition = (ok) => {
      window.finishLocation = () => ok({ coords: { latitude: 35, longitude: -119, accuracy: 5 } });
    };
    return state.draft.inspection_id;
  });
  await addImage(page);
  await expect.poll(() => page.evaluate(() => state.draft.photos.length)).toBe(1);
  await page.locator('#forkLocal').click({ force: true });
  expect(await page.evaluate(() => state.draft.inspection_id)).toBe(original);
  await page.evaluate(() => window.finishLocation());
  await expect.poll(() => page.evaluate(() => state.draft.inspection_id)).not.toBe(original);
  expect(await page.evaluate(() => state.draft.photos.map((photo) => photo.location))).toEqual([
    { source: 'device', latitude: 35, longitude: -119, accuracy_m: 5 },
  ]);
});

test('an unavailable device fix saves an explicit missing location', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (ok, fail) => fail({ code: 2 });
  });
  await addImage(page);
  await expect(page.locator('#photoGallery')).toContainText('Location not available');
  expect(await settled(page)).toEqual([{ source: 'not_available' }]);
  await finish(page);
  await expect(page.locator('#photoAuditLog')).toContainText('Location not available');
  await expect(page.locator('#photoAuditLog a')).toHaveCount(0);
});

test('new proposal includes approved privacy wording and signing freezes GPS and documents', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(FIX);
  await open(page);
  await addImage(page);
  await settled(page);
  await finish(page);
  await page.locator('[data-tab=proposal]').click();
  await expect(page.locator('#proposalBody')).toContainText(
    "Photos taken during the inspection are stamped with the location reported by the technician's phone, when the technician allows it, and that location is part of the photo log.",
  );
  await page.locator('#documentsConfirmed').check();
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 30);
  await page.mouse.down();
  await page.mouse.move(rect.x + 150, rect.y + 70, { steps: 8 });
  await page.mouse.up();
  await page.locator('#authorizeJob').click();
  await expect(page.locator('#saveStatus')).toHaveText('Signed');
  const snapshot = await page.evaluate(() => ({
    uid: sessionStorage.getItem('synthetic-uid'),
    id: state.draft.inspection_id,
    record: state.record,
  }));
  const headers = { Authorization: 'Bearer ' + snapshot.uid };
  const before = await (
    await page.request.get('/api/inspections/' + snapshot.id, { headers })
  ).json();
  const response = await page.request.post('/api/inspections/' + snapshot.id + '/photos', {
    headers,
    data: {
      expected_revision: before.revision,
      photo_id: 'c'.repeat(32),
      room: before.photos[0].room,
      captured_at: '2026-10-24T12:00:00Z',
      data_url: await page.evaluate(() =>
        (() => {
          const c = document.createElement('canvas');
          c.width = 200;
          c.height = 300;
          c.getContext('2d').fillRect(0, 0, 100, 150);
          return c.toDataURL('image/png');
        })(),
      ),
      location: { source: 'device', latitude: 0, longitude: 0, accuracy_m: 1 },
    },
  });
  expect(response.status(), await response.text()).toBe(409);
  const after = await (
    await page.request.get('/api/inspections/' + snapshot.id, { headers })
  ).json();
  expect(after.photos).toEqual(before.photos);
  expect(after.audit.documents).toEqual(before.audit.documents);
  await page.locator('[data-tab=photos]').click();
  await expect(page.locator('#photoAuditLog')).toContainText('35.373292, -119.018712');
  require('node:fs').writeFileSync(
    test.info().outputPath('signed-evidence.json'),
    JSON.stringify({ rejected_status: response.status(), before, after }, null, 2),
  );
});
