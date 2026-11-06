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

test('an originals run reads each not-ready original once, however many it sends', async ({
  page,
  context,
}) => {
  await countOriginalReads(page);
  await open(page);
  await context.setOffline(true);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await addJpeg(page, name, 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(3);
  // The copies cannot reach the server, so their originals stay not ready, except the last in
  // key order: the run reads past the other two to reach it.
  await page.route('**/api/inspections/*/photos', (route) => route.abort('failed'));
  await page.evaluate(async () => {
    const [last] = (await originalsAction('readonly', (o) => o.getAll())).sort((a, b) =>
      a.id < b.id ? 1 : -1,
    );
    await originalsAction('readwrite', (o) => o.put({ ...last, ready: true }));
  });
  await context.setOffline(false);
  await expect(page.locator('#uploadOriginals')).toBeEnabled();
  await originalReads(page);
  // The server has no copy of it yet, so it refuses the original and the run looks again.
  const refused = page.waitForResponse((r) => isOriginal(r.request()) && r.status() === 404);
  await page.locator('#uploadOriginals').click();
  await refused;
  await settled(page);
  expect(await originalReads(page)).toBe(3);
  expect(await kept(page)).toHaveLength(3);
});

test('an original that becomes ready during a run is sent without another tap', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const connection = new EventTarget();
    connection.type = 'cellular';
    Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
  });
  await open(page);
  await addJpeg(page, 'one.jpg', 3000, 2000);
  await settled(page);
  await addJpeg(page, 'two.jpg', 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(2);
  await settled(page);
  // The first in key order is still waiting for its copy when the run passes it.
  const [early, late] = (await kept(page)).map((row) => row.id).sort();
  await page.evaluate(async (id) => {
    const key = draftKey(state.draft.inspection_id);
    const row = await originalsAction('readonly', (o) => o.get([key, id]));
    await originalsAction('readwrite', (o) => o.put({ ...row, ready: false }));
  }, early);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/photos/' + late + '/original', async (route) => {
    await held;
    await route.continue();
  });
  const sending = page.waitForRequest(isOriginal);
  await page.evaluate(() => {
    navigator.connection.type = 'wifi';
    navigator.connection.dispatchEvent(new Event('change'));
  });
  await sending;
  // Its copy is saved meanwhile, as a sync does, which asks for originals again.
  await page.evaluate(async (id) => {
    const key = draftKey(state.draft.inspection_id);
    const row = await originalsAction('readonly', (o) => o.get([key, id]));
    await originalsAction('readwrite', (o) => o.put({ ...row, ready: true }));
    uploadOriginals();
  }, early);
  release();
  await expect.poll(() => kept(page), { timeout: 15000 }).toEqual([]);
  await expect(page.locator('#originals')).toBeHidden();
  // Each original went up once, after the copies; no tap was needed.
  expect((await sent(page)).filter((u) => u.kind === 'bytes')).toHaveLength(2);
});

test('during a tapped run, an original that becomes ready is sent without a Wi-Fi report', async ({
  page,
}) => {
  await open(page);
  await addJpeg(page, 'one.jpg', 3000, 2000);
  await settled(page);
  await addJpeg(page, 'two.jpg', 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(2);
  await settled(page);
  const [early, late] = (await kept(page)).map((row) => row.id).sort();
  await page.evaluate(async (id) => {
    const key = draftKey(state.draft.inspection_id);
    const row = await originalsAction('readonly', (o) => o.get([key, id]));
    await originalsAction('readwrite', (o) => o.put({ ...row, ready: false }));
  }, early);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/photos/' + late + '/original', async (route) => {
    await held;
    await route.continue();
  });
  const sending = page.waitForRequest(isOriginal);
  await page.locator('#uploadOriginals').click();
  await sending;
  // A sync saves its copy meanwhile and asks for originals, as it does after every sync.
  await page.evaluate(async (id) => {
    const key = draftKey(state.draft.inspection_id);
    const row = await originalsAction('readonly', (o) => o.get([key, id]));
    await originalsAction('readwrite', (o) => o.put({ ...row, ready: true }));
    uploadOriginals();
  }, early);
  release();
  await expect.poll(() => kept(page), { timeout: 15000 }).toEqual([]);
  expect((await sent(page)).filter((u) => u.kind === 'bytes')).toHaveLength(2);
});

test('an automatic run stops before the next original once the phone leaves Wi-Fi', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const connection = new EventTarget();
    connection.type = 'cellular';
    Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
  });
  await open(page);
  await addJpeg(page, 'one.jpg', 3000, 2000);
  await settled(page);
  await addJpeg(page, 'two.jpg', 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(2);
  await settled(page);
  expect(await kept(page)).toHaveLength(2);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/photos/*/original', async (route) => {
    await held;
    await route.continue();
  });
  const sending = page.waitForRequest(isOriginal);
  await page.evaluate(() => {
    navigator.connection.type = 'wifi';
    navigator.connection.dispatchEvent(new Event('change'));
  });
  await sending;
  await page.evaluate(() => {
    navigator.connection.type = 'cellular';
    navigator.connection.dispatchEvent(new Event('change'));
  });
  release();
  await settled(page);
  // The one already on its way finishes; the other waits for Wi-Fi.
  expect((await sent(page)).filter((u) => u.kind === 'bytes')).toHaveLength(1);
  expect(await kept(page)).toEqual([expect.objectContaining({ ready: true })]);
  await expect(page.locator('#originalsCount')).toHaveText(
    '1 full-size original waiting on this phone.',
  );
});

test('an original whose copy reached the server unseen is ready once the job reopens', async ({
  page,
  context,
}) => {
  await open(page);
  await context.setOffline(true);
  await addJpeg(page, 'lost.jpg', 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(1);
  let blocked = true;
  await page.route('**/api/inspections/*/photos', (route) =>
    blocked && route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
  );
  const failed = page.waitForEvent('requestfailed', (r) => /\/photos$/.test(r.url()));
  await context.setOffline(false);
  await failed;
  await page.evaluate(() => syncChain.catch(() => {}));
  // The server saves the copy, but its answer never reaches the phone.
  blocked = false;
  await page.evaluate(async () => {
    const photo = state.draft.photos[0];
    await jsonApi(
      '/api/inspections/' + state.draft.inspection_id + '/photos',
      'POST',
      photoForm(photo, state.record.revision, photo.data_url),
    );
  });
  blocked = true;
  expect(await kept(page)).toEqual([expect.objectContaining({ ready: false })]);
  await page.evaluate(() => restoreDraft(state.draft.inspection_id));
  expect(await page.evaluate(() => state.draft.photos[0].uploaded)).toBe(true);
  // Signing later clears the draft, which would drop an original that is not ready.
  await expect.poll(() => kept(page)).toEqual([expect.objectContaining({ ready: true })]);
});

// The copy of a photo taken offline reaches the server, but its answer never reaches the phone,
// and the phone's own tries fail.
async function copySavedUnseen(page, context) {
  await context.setOffline(true);
  await addJpeg(page, 'unseen.jpg', 3000, 2000);
  await expect(page.locator('#photoGallery .photo')).toHaveCount(1);
  let blocked = true;
  await page.route('**/api/inspections/*/photos', (route) =>
    blocked && route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
  );
  const failed = page.waitForEvent('requestfailed', (r) => /\/photos$/.test(r.url()));
  await context.setOffline(false);
  await failed;
  await page.evaluate(() => syncChain.catch(() => {}));
  blocked = false;
  await page.evaluate(async () => {
    const photo = state.draft.photos[0];
    await jsonApi(
      '/api/inspections/' + state.draft.inspection_id + '/photos',
      'POST',
      photoForm(photo, state.record.revision, photo.data_url),
    );
  });
  blocked = true;
  expect(await kept(page)).toEqual([expect.objectContaining({ ready: false })]);
}

test('restoring the saved version after a lost upload answer keeps the original and sends it', async ({
  page,
  context,
}) => {
  await open(page);
  await copySavedUnseen(page, context);
  await page.evaluate(() => {
    state.conflict = true;
    document.getElementById('conflictActions').hidden = false;
  });
  await page.locator('#restoreRemote').click({ force: true });
  await expect.poll(() => page.evaluate(() => state.conflict)).toBe(false);
  await expect.poll(() => kept(page)).toEqual([expect.objectContaining({ ready: true })]);
  const confirmed = page.waitForResponse(originalOk);
  await page.locator('#uploadOriginals').click();
  await confirmed;
  await settled(page);
  expect(await kept(page)).toEqual([]);
});

test('a separate inspection made from a conflict promises none of the originals', async ({
  page,
}) => {
  await open(page);
  await addJpeg(page, 'conflict.jpg');
  await settled(page);
  const source = await page.evaluate(() => ({
    job: state.draft.inspection_id,
    photo: state.draft.photos[0].id,
  }));
  await page.evaluate(() => {
    state.conflict = true;
    document.getElementById('conflictActions').hidden = false;
  });
  await page.locator('#forkLocal').click({ force: true });
  await expect.poll(() => page.evaluate(() => state.draft.inspection_id)).not.toBe(source.job);
  await expect.poll(() => page.evaluate(() => state.draft.photos[0].uploaded)).toBe(true);
  await settled(page);
  const forked = await page.evaluate(() => state.record.photos[0]);
  expect(forked.original).toBeUndefined();
  expect((await sent(page)).at(-1).metadata.original).toBeUndefined();
  // The original stays with, and still goes to, the job that promised it.
  expect(await kept(page)).toEqual([expect.objectContaining({ id: source.photo, ready: true })]);
});

test.describe('an archived job saved as a new draft', () => {
  const JOB = 'ADR-INS-' + 'c'.repeat(32);
  const owner = { Authorization: 'Bearer test-owner-ws-owner', 'X-ADR-Workspace-Protocol': '1' };
  test.use({ viewport: { width: 1280, height: 900 } });
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });

  // An estimator's photo taken offline on a job the owner then archives; the phone holds its
  // original, which never followed a copy to the server.
  async function archivedWithOriginal(page, context, request, names = ['archived.jpg']) {
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      'test-owner-ws-estimator',
    );
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.locator('#dashboardJobs').click();
    await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await context.setOffline(true);
    for (const name of names) await addJpeg(page, name);
    await expect(page.locator('#photoGallery .photo')).toHaveCount(names.length);
    expect(await kept(page)).toEqual(names.map(() => expect.objectContaining({ ready: false })));
    const job = await (
      await request.get('/api/jobs/' + JOB + '/coordination', { headers: owner })
    ).json();
    expect(
      (
        await request.post('/api/jobs/' + JOB + '/archive', {
          headers: owner,
          data: { expected_version: job.version },
        })
      ).status(),
    ).toBe(200);
    await context.setOffline(false);
    await page.evaluate(() => syncDraft().catch(() => {}));
    await expect(page.locator('#archivedActions')).toBeVisible();
  }

  test('takes the originals this phone holds with it', async ({ page, context, request }) => {
    await archivedWithOriginal(page, context, request);
    await page.locator('#forkArchived').click();
    await expect(page.locator('#archivedActions')).toBeHidden();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const forked = await page.evaluate(() => ({
      job: state.draft.inspection_id,
      photo: state.record.photos[0],
    }));
    expect(forked.job).not.toBe(JOB);
    expect(forked.photo.original).toEqual(expect.objectContaining({ content_type: 'image/jpeg' }));
    // Kept under the new job and photo, and ready to follow the copy that job now holds.
    await expect
      .poll(() => kept(page))
      .toEqual([expect.objectContaining({ id: forked.photo.id, ready: true })]);
  });

  test('takes them with it even when the first sync of the new job fails', async ({
    page,
    context,
    request,
  }) => {
    await archivedWithOriginal(page, context, request);
    const archived = await page.evaluate(() => draftKey(state.draft.inspection_id));
    await page.route(
      '**/api/inspections/*/photos',
      (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue()),
      { times: 1 },
    );
    const failed = page.waitForEvent('requestfailed', (r) => /\/photos$/.test(r.url()));
    await page.locator('#forkArchived').click();
    await failed;
    await expect
      .poll(() => page.evaluate(() => draftKey(state.draft.inspection_id)))
      .not.toBe(archived);
    // The new job's copy promises the original, so the original sits under that job and photo.
    const forked = await page.evaluate(() => ({
      key: draftKey(state.draft.inspection_id),
      photo: state.draft.photos[0],
    }));
    expect(forked.photo.original).toEqual(expect.objectContaining({ content_type: 'image/jpeg' }));
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await originalsAction('readonly', (o) => o.getAll())).map((row) => [
            row.draft_key,
            row.id,
          ]),
        ),
      )
      .toEqual([[forked.key, forked.photo.id]]);
  });

  test('keeps ready the originals whose copies the new job saved before its sync failed', async ({
    page,
    context,
    request,
  }) => {
    await archivedWithOriginal(page, context, request, ['first.jpg', 'second.jpg']);
    const archived = await page.evaluate(() => draftKey(state.draft.inspection_id));
    await failAfterFirstCopy(page);
    const failed = page.waitForEvent('requestfailed', (r) => /\/photos$/.test(r.url()));
    await page.locator('#forkArchived').click();
    await failed;
    await expect
      .poll(() => page.evaluate(() => draftKey(state.draft.inspection_id)))
      .not.toBe(archived);
    const [first, second] = await page.evaluate(() => state.draft.photos.map((p) => p.id));
    await expect
      .poll(() => page.evaluate(() => state.record?.photos.map((p) => p.id)))
      .toEqual([first]);
    // The new job holds the first copy, so its original stays ready and a later clean-up keeps it.
    await expect
      .poll(async () => Object.fromEntries((await kept(page)).map((row) => [row.id, row.ready])))
      .toEqual({ [first]: true, [second]: false });
  });
});

test.describe('a job signed on another device', () => {
  const JOB = 'ADR-INS-' + 'c'.repeat(32);
  const AUTH = 'ADR-AUTH-unseencopy1';
  const estimator = {
    Authorization: 'Bearer test-owner-ws-estimator',
    'X-ADR-Workspace-Protocol': '1',
  };
  test.use({ viewport: { width: 1280, height: 900 } });
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });

  test('keeps an original whose copy reached the server unseen when opened here', async ({
    page,
    context,
    request,
  }) => {
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      'test-owner-ws-estimator',
    );
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.locator('#dashboardJobs').click();
    await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await copySavedUnseen(page, context);
    const signature = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 60;
      const context = canvas.getContext('2d');
      context.lineWidth = 3;
      context.moveTo(10, 35);
      context.lineTo(40, 12);
      context.lineTo(105, 15);
      context.stroke();
      return canvas.toDataURL('image/png');
    });
    // The other device runs recognition, confirms the scope, audits and signs the job.
    await context.setOffline(true);
    const before = await (
      await request.get('/api/inspections/' + JOB, { headers: estimator })
    ).json();
    expect(before.photos).toHaveLength(1);
    const ocr = await request.post(
      '/api/inspections/' + JOB + '/photos/' + before.photos[0].id + '/ocr',
      { headers: estimator, data: {} },
    );
    expect(ocr.status()).toBe(200);
    const saved = await ocr.json();
    const confirmed = await (
      await request.put('/api/inspections/' + JOB, {
        headers: estimator,
        data: { expected_revision: saved.revision, data: { ...saved.data, scope_confirmed: true } },
      })
    ).json();
    const audit = await (
      await request.post('/api/audit', {
        headers: estimator,
        data: { inspection_id: JOB, expected_revision: confirmed.revision },
      })
    ).json();
    const signed = await request.post('/api/authorize', {
      headers: estimator,
      data: {
        inspection_id: JOB,
        expected_revision: audit.revision,
        auth_id: AUTH,
        proposal_hash: audit.audit.proposal_hash,
        signature_png: signature,
        documents_confirmed: true,
      },
    });
    expect(signed.status()).toBe(200);
    await context.setOffline(false);
    // Opening the agreement clears this phone's draft; the original the job expects stays.
    await page.evaluate((id) => restoreSigned(id), AUTH);
    expect(await kept(page)).toEqual([expect.objectContaining({ ready: true })]);
  });
});
