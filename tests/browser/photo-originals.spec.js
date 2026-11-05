const { test, expect } = require('@playwright/test');

// Photos upload first as a binary copy of at most 2,560 px; the full-size original stays on the
// phone and follows on Wi-Fi: on its own where the browser reports Wi-Fi (Chromium on Android),
// and after the "Upload originals now" tap everywhere else (iPhone Safari reports no connection).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

const isOriginal = (request) =>
  request.method() === 'POST' && /\/photos\/[a-f0-9]{32}\/original$/.test(request.url());
const originalOk = (response) => isOriginal(response.request()) && response.status() === 200;

// Records what the app hands to fetch for each photo or original upload. Playwright cannot read
// a FormData or binary request body, so the page describes it: form parts or raw bytes.
async function open(page) {
  await page.addInitScript(() => {
    window.sentPhotos = [];
    const send = window.fetch;
    window.fetch = function (input, init = {}) {
      const url = String(input?.url || input);
      if (init.method === 'POST' && /\/photos(\/[a-f0-9]{32}\/original)?$/.test(url)) {
        const body = init.body;
        window.sentPhotos.push(
          body instanceof FormData
            ? {
                kind: 'form',
                metadata: JSON.parse(body.get('metadata')),
                file: { type: body.get('file').type, size: body.get('file').size },
              }
            : body instanceof ArrayBuffer
              ? { kind: 'bytes', type: init.headers?.['Content-Type'], size: body.byteLength }
              : { kind: typeof body },
        );
      }
      return send.apply(this, arguments);
    };
  });
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
const sent = (page) => page.evaluate(() => window.sentPhotos);
// A camera-sized JPEG (4000 x 3000 unless given), made in the page and chosen as a file.
async function addJpeg(page, name, width = 4000, height = 3000) {
  const image = await page.evaluate(
    ([width, height]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#4a6';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#222';
      context.fillRect(0, 0, width / 3, height / 2);
      return canvas.toDataURL('image/jpeg', 0.92);
    },
    [width, height],
  );
  const buffer = Buffer.from(image.split(',')[1], 'base64');
  await page.locator('#photoFileInput').setInputFiles({ name, mimeType: 'image/jpeg', buffer });
  return buffer;
}
const settled = (page) =>
  page.evaluate(async () => {
    await syncChain.catch(() => {});
    await Promise.all([...state.ocr.values()]);
    await originalsRun;
  });
// The test's own look at the stored originals is left out of any read count the page keeps.
const kept = (page) =>
  page.evaluate(async () => {
    const reads = window.originalReads;
    const rows = await originalsAction('readonly', (originals) => originals.getAll());
    window.originalReads = reads;
    return rows.map((row) => ({
      id: row.id,
      ready: row.ready,
      size: row.bytes.byteLength,
      type: row.content_type,
    }));
  });

test('a large photo uploads as a 2,560 px binary copy and its original waits on the phone', async ({
  page,
}) => {
  await open(page);
  const original = await addJpeg(page, 'camera.jpg');
  await expect(page.locator('#photoGallery .photo')).toHaveCount(1);
  await settled(page);
  // Binary multipart with a JPEG copy smaller than the original, never base64 JSON.
  const [upload, ...rest] = await sent(page);
  expect(rest).toEqual([]);
  expect(upload.kind).toBe('form');
  expect(upload.metadata.data_url).toBeUndefined();
  expect(upload.file.type).toBe('image/jpeg');
  expect(upload.file.size).toBeLessThan(original.length);
  // The server holds the copy and the original's hash; the phone keeps the copy for display.
  const saved = await page.evaluate(() => ({
    photo: state.record.photos[0],
    local: state.draft.photos[0].data_url.slice(0, 23),
  }));
  expect([saved.photo.width, saved.photo.height]).toEqual([2560, 1920]);
  expect(saved.photo.original).toEqual({
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    content_type: 'image/jpeg',
  });
  expect(upload.metadata.original).toEqual(saved.photo.original);
  expect(saved.local).toBe('data:image/jpeg;base64,');
  // The original stays here, ready to follow its copy, and nothing used the connection for it.
  expect(await kept(page)).toEqual([
    { id: saved.photo.id, ready: true, size: original.length, type: 'image/jpeg' },
  ]);
  await expect(page.locator('#originalsCount')).toHaveText(
    '1 full-size original waiting on this phone.',
  );
  await expect(page.locator('#uploadOriginals')).toHaveText('Upload originals now (use Wi-Fi)');
  await expect(page.locator('#uploadOriginals')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('without a Wi-Fi report, only the tap sends originals; a failed try keeps it for a retry', async ({
  page,
}) => {
  await open(page);
  const original = await addJpeg(page, 'one.jpg');
  await settled(page);
  expect(await sent(page)).toHaveLength(1);
  await page.route('**/photos/*/original', (route) => route.abort('failed'), { times: 1 });
  const failed = page.waitForEvent('requestfailed', isOriginal);
  await page.locator('#uploadOriginals').click();
  await failed;
  await settled(page);
  // Nothing is deleted before the server confirms it, and the copy is not sent again.
  expect(await kept(page)).toHaveLength(1);
  await expect(page.locator('#originalsCount')).toHaveText(
    '1 full-size original waiting on this phone.',
  );
  const confirmed = page.waitForResponse(originalOk);
  await page.locator('#uploadOriginals').click();
  // The server confirmed it (200); only then is the phone's copy of the original deleted.
  await confirmed;
  await settled(page);
  expect(await kept(page)).toEqual([]);
  await expect(page.locator('#originals')).toBeHidden();
  const uploads = await sent(page);
  expect(uploads.map((u) => u.kind)).toEqual(['form', 'bytes', 'bytes']);
  expect(uploads[2]).toMatchObject({ type: 'image/jpeg', size: original.length });
});

test('where the browser reports Wi-Fi, originals upload on their own once it joins', async ({
  page,
}) => {
  // Chromium on Android exposes the connection type; this stands in for it on every engine.
  await page.addInitScript(() => {
    const connection = new EventTarget();
    connection.type = 'cellular';
    Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
  });
  await open(page);
  await addJpeg(page, 'cellular.jpg');
  await settled(page);
  // On cellular data nothing goes up by itself.
  expect((await sent(page)).map((u) => u.kind)).toEqual(['form']);
  expect(await kept(page)).toHaveLength(1);
  const confirmed = page.waitForResponse(originalOk);
  await page.evaluate(() => {
    navigator.connection.type = 'wifi';
    navigator.connection.dispatchEvent(new Event('change'));
  });
  await confirmed;
  await settled(page);
  expect(await kept(page)).toEqual([]);
  await expect(page.locator('#originals')).toBeHidden();
  // A photo taken while on Wi-Fi sends its original right after its copy.
  const next = page.waitForResponse(originalOk);
  await addJpeg(page, 'wifi.jpg');
  await next;
  await settled(page);
  expect(await kept(page)).toEqual([]);
  expect((await sent(page)).map((u) => u.kind)).toEqual(['form', 'bytes', 'form', 'bytes']);
});

test('a failed photo upload resends only that photo', async ({ page }) => {
  await open(page);
  await addJpeg(page, 'first.jpg', 1200, 900);
  await settled(page);
  await page.route('**/api/inspections/*/photos', (route) => route.abort('failed'), { times: 1 });
  const failed = page.waitForEvent('requestfailed', (request) => /\/photos$/.test(request.url()));
  await addJpeg(page, 'second.jpg');
  await failed;
  // The app retries on its own; a sync here only makes the retry prompt.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          await syncDraft().catch(() => {});
          return state.draft.photos.map((p) => p.uploaded);
        }),
      { timeout: 15000 },
    )
    .toEqual([true, true]);
  await settled(page);
  const ids = await page.evaluate(() => state.draft.photos.map((p) => [p.id]));
  expect((await sent(page)).map((u) => u.metadata.photo_id)).toEqual([
    ids[0][0],
    ids[1][0],
    ids[1][0],
  ]);
  // A photo already small enough is its own original and keeps nothing extra.
  const record = await page.evaluate(() => state.record.photos.map((p) => !!p.original));
  expect(record).toEqual([false, true]);
  expect(await kept(page)).toEqual([expect.objectContaining({ id: ids[1][0], ready: true })]);
});

test('a photo taken offline keeps its original until its copy is saved online', async ({
  page,
  context,
}) => {
  await open(page);
  await context.setOffline(true);
  await addJpeg(page, 'offline.jpg');
  await expect(page.locator('#photoGallery .photo')).toHaveCount(1);
  await expect(page.locator('#originalsCount')).toHaveText(
    '1 full-size original waiting on this phone.',
  );
  await expect(page.locator('#uploadOriginals')).toBeDisabled();
  expect(await kept(page)).toEqual([expect.objectContaining({ ready: false })]);
  await context.setOffline(false);
  await expect
    .poll(async () => (await kept(page)).map((row) => row.ready), { timeout: 15000 })
    .toEqual([true]);
  await expect(page.locator('#uploadOriginals')).toBeEnabled();
  expect((await sent(page)).map((u) => u.kind)).toEqual(['form']);
});

test('when the phone cannot keep the original, the copy is still saved and promises none', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.keepOriginal = async () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await addJpeg(page, 'full.jpg');
  await expect(page.locator('#message')).toContainText('could not keep the full-size original');
  await settled(page);
  const photo = await page.evaluate(() => state.record.photos[0]);
  expect(photo.width).toBe(2560);
  expect(photo.original).toBeUndefined();
  expect(await kept(page)).toEqual([]);
  await expect(page.locator('#originals')).toBeHidden();
});

test('sign-out names the originals kept only on this phone before it removes them', async ({
  page,
}) => {
  await open(page);
  await addJpeg(page, 'kept.jpg');
  await settled(page);
  expect(await kept(page)).toHaveLength(1);
  await page.waitForFunction(() => state.session && !state.workspaceInitializing);
  // On a phone with a job open, Account sits inside the job's More menu.
  await page.locator('#jobMenu > summary').click();
  await page.locator('#accountMenu > summary').click();
  await page.locator('#signOutButton').click();
  await expect(page.locator('#unsyncedCount')).toHaveText(
    '1 full-size photo original is kept only on this phone. Its 2,560 px copy is saved. Upload originals on Wi-Fi first, or sign out to remove it.',
  );
  await expect(page.locator('#googleSignIn')).toBeHidden();
  expect(await kept(page)).toHaveLength(1);
  // Close the open menus, which overlap the notice on a phone.
  await page.keyboard.press('Escape');
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.locator('#discardSignOut').click(),
  ]);
  await expect(page.locator('#googleSignIn')).toBeVisible();
  expect(await kept(page)).toEqual([]);
});

// Counts the stored originals (each carrying its full bytes) the page reads from IndexedDB.
async function countOriginalReads(page) {
  await page.addInitScript(() => {
    window.originalReads = 0;
    const value = Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, 'value');
    Object.defineProperty(IDBCursorWithValue.prototype, 'value', {
      ...value,
      get() {
        if (this.source?.name === 'originals') window.originalReads++;
        return value.get.call(this);
      },
    });
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function () {
      const request = get.apply(this, arguments);
      if (this.name === 'originals')
        request.addEventListener('success', () => request.result && window.originalReads++);
      return request;
    };
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function () {
      const request = getAll.apply(this, arguments);
      if (this.name === 'originals')
        request.addEventListener('success', () => (window.originalReads += request.result.length));
      return request;
    };
  });
}
const originalReads = (page) =>
  page.evaluate(() => {
    const reads = window.originalReads;
    window.originalReads = 0;
    return reads;
  });
async function newJob(page) {
  await page.locator('#jobMenu > summary').click();
  await page.locator('#newInspection').click();
  await expect(page.locator('#address')).toHaveValue('');
}

test('a refused original does not hold back the others; only a refusal for good frees it', async ({
  page,
}) => {
  await open(page);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']) await addJpeg(page, name, 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(4);
  await settled(page);
  expect(await kept(page)).toHaveLength(4);
  // The first is on an archived job, the second on a job no longer assigned (or a server without
  // the route), the third is not the original the server expects; the fourth goes through.
  const refusals = [410, 404, 409];
  const refused = {};
  await page.route('**/photos/*/original', (route) => {
    const status = refusals.shift();
    if (!status) return route.continue();
    refused[status] = route.request().url().split('/').at(-2);
    return route.fulfill({ status, contentType: 'application/json', body: '{"detail":"No."}' });
  });
  const confirmed = page.waitForResponse(originalOk);
  await page.locator('#uploadOriginals').click();
  await confirmed;
  await settled(page);
  // The archived and not-found ones stay for a later try; the mismatched one is freed.
  expect((await kept(page)).map((row) => row.id).sort()).toEqual(
    [refused[410], refused[404]].sort(),
  );
  await expect(page.locator('#originalsCount')).toHaveText(
    '2 full-size originals waiting on this phone.',
  );
  await page.locator('#uploadOriginals').click();
  await settled(page);
  expect(await kept(page)).toEqual([]);
});

test('an originals run reads each waiting original once, not every one per upload', async ({
  page,
}) => {
  await countOriginalReads(page);
  await open(page);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await addJpeg(page, name, 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(3);
  await settled(page);
  expect(await kept(page)).toHaveLength(3);
  await originalReads(page);
  await page.locator('#uploadOriginals').click();
  await expect(page.locator('#originals')).toBeHidden();
  await settled(page);
  expect(await originalReads(page)).toBe(3);
  expect(await kept(page)).toEqual([]);
});

test('a queued job reads its originals once when its photos reach the server', async ({
  page,
  context,
}) => {
  await countOriginalReads(page);
  await open(page);
  await context.setOffline(true);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await addJpeg(page, name, 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(3);
  await newJob(page);
  expect((await kept(page)).map((row) => row.ready)).toEqual([false, false, false]);
  await originalReads(page);
  await context.setOffline(false);
  await expect
    .poll(async () => (await kept(page)).map((row) => row.ready), { timeout: 15000 })
    .toEqual([true, true, true]);
  expect(await originalReads(page)).toBe(3);
});

test('a queued job signed on another device keeps the originals the server already expects', async ({
  page,
  context,
}) => {
  await open(page);
  await context.setOffline(true);
  await addJpeg(page, 'signed.jpg');
  await expect(page.locator('#photoGallery .photo')).toHaveCount(1);
  const queued = await page.evaluate(async () => {
    const [row] = await originalsAction('readonly', (originals) => originals.getAll());
    return { id: state.draft.inspection_id, photo: row.id, sha256: row.sha256 };
  });
  await newJob(page);
  expect(await kept(page)).toEqual([expect.objectContaining({ ready: false })]);
  // Its copy reached the server before the connection dropped, and the job was then signed.
  await page.route('**/api/inspections/' + queued.id, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        inspection_id: queued.id,
        status: 'signed',
        revision: 2,
        data: {},
        photos: [
          { id: queued.photo, original: { sha256: queued.sha256, content_type: 'image/jpeg' } },
        ],
      }),
    }),
  );
  await context.setOffline(false);
  await expect
    .poll(
      () =>
        page.evaluate(
          async (id) => (await localDrafts()).some((row) => row.draft.inspection_id === id),
          queued.id,
        ),
      { timeout: 15000 },
    )
    .toBe(false);
  expect(await kept(page)).toEqual([expect.objectContaining({ id: queued.photo, ready: true })]);
});

test('saving a draft reads none of its originals', async ({ page, context }) => {
  await countOriginalReads(page);
  await open(page);
  await context.setOffline(true);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await addJpeg(page, name, 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(3);
  await page.evaluate(() => persist());
  await originalReads(page);
  await page.evaluate(() => {
    state.draft.data.technician_notes = 'Wet drywall in the hall';
    return persist();
  });
  expect(await originalReads(page)).toBe(0);
  expect(await kept(page)).toHaveLength(3);
});

test('refused originals are not read again while the rest of the run goes', async ({ page }) => {
  await countOriginalReads(page);
  await open(page);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await addJpeg(page, name, 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(3);
  await settled(page);
  let refusals = 2;
  await page.route('**/photos/*/original', (route) =>
    refusals-- > 0
      ? route.fulfill({ status: 410, contentType: 'application/json', body: '{"detail":"No."}' })
      : route.continue(),
  );
  await originalReads(page);
  const confirmed = page.waitForResponse(originalOk);
  await page.locator('#uploadOriginals').click();
  await confirmed;
  await settled(page);
  expect(await originalReads(page)).toBe(3);
  expect(await kept(page)).toHaveLength(2);
});

test('after the request limit, originals start again once the server allows', async ({ page }) => {
  await open(page);
  await addJpeg(page, 'limited.jpg');
  await settled(page);
  await page.route(
    '**/photos/*/original',
    (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '1' },
        contentType: 'application/json',
        body: '{"detail":"Too many requests."}',
      }),
    { times: 1 },
  );
  const limited = page.waitForResponse((r) => isOriginal(r.request()) && r.status() === 429);
  await page.locator('#uploadOriginals').click();
  await limited;
  // No second tap: the run starts again after the server's Retry-After.
  await page.waitForResponse(originalOk, { timeout: 10000 });
  await settled(page);
  expect(await kept(page)).toEqual([]);
});

// Lets the first photo copy through and fails every later one, as when the signal drops midway.
async function failAfterFirstCopy(page) {
  let copies = 0;
  await page.route('**/api/inspections/*/photos', (route) =>
    route.request().method() === 'POST' && copies++ > 0 ? route.abort('failed') : route.continue(),
  );
}

test('an open job marks each original ready as soon as its copy is saved', async ({
  page,
  context,
}) => {
  await open(page);
  await context.setOffline(true);
  await addJpeg(page, 'first.jpg');
  await addJpeg(page, 'second.jpg');
  await expect(page.locator('#photoGallery .photo')).toHaveCount(2);
  const [first, second] = await page.evaluate(() => state.draft.photos.map((p) => p.id));
  await failAfterFirstCopy(page);
  await context.setOffline(false);
  await expect
    .poll(async () => Object.fromEntries((await kept(page)).map((row) => [row.id, row.ready])), {
      timeout: 15000,
    })
    .toEqual({ [first]: true, [second]: false });
});

test('a queued job marks each original ready as soon as its copy is saved', async ({
  page,
  context,
}) => {
  await open(page);
  await context.setOffline(true);
  await addJpeg(page, 'first.jpg');
  await addJpeg(page, 'second.jpg');
  await expect(page.locator('#photoGallery .photo')).toHaveCount(2);
  const [first, second] = await page.evaluate(() => state.draft.photos.map((p) => p.id));
  await newJob(page);
  await failAfterFirstCopy(page);
  await context.setOffline(false);
  await expect
    .poll(async () => Object.fromEntries((await kept(page)).map((row) => [row.id, row.ready])), {
      timeout: 15000,
    })
    .toEqual({ [first]: true, [second]: false });
});
