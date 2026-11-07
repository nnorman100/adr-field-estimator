const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

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

async function failAfterFirstCopy(page) {
  let copies = 0;
  await page.route('**/api/inspections/*/photos', (route) =>
    route.request().method() === 'POST' && copies++ > 0 ? route.abort('failed') : route.continue(),
  );
}

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
