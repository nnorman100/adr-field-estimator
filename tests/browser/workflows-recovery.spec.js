const { saveDraft, checkScope } = require('./actions');
const { test, expect } = require('@playwright/test');
test.beforeEach(async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
});
async function task(page, name) {
  await page.locator('.task-nav [data-task="' + name + '"]').click();
}
async function menu(page, id) {
  await page.waitForFunction(() => state.session && !state.workspaceInitializing);
  const m = page.locator('#' + id);
  if (!(await m.evaluate((el) => el.open))) await m.locator(':scope > summary').click();
}
async function scope(page) {
  await task(page, 'property');
  await page.locator('#address').fill('Synthetic browser property');
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function audit(page) {
  await scope(page);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
}
async function draw(page) {
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  await canvas.click({ position: { x: 10, y: 10 } });
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 30, rect.y + 40);
  await page.mouse.down();
  await page.mouse.move(rect.x + 110, rect.y + 100, { steps: 8 });
  await page.mouse.move(rect.x + 220, rect.y + 30, { steps: 8 });
  await page.mouse.up();
}

async function fault(page, faults) {
  return page.evaluate(
    async (faults) =>
      (
        await fetch('/__test/fault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: sessionStorage.getItem('synthetic-uid'), faults }),
        })
      ).json(),
    faults,
  );
}
test('reopening a draft after a signed job releases the signed photo object URLs', async ({
  page,
}) => {
  await page.locator('#address').fill('Draft to reopen');
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await menu(page, 'jobMenu');
  await page.locator('#newInspection').click();
  await expect(page.locator('#address')).toHaveValue('');
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 600;
    return c.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({
    name: 'signed.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
  await expect(page.locator('#photoGallery')).toContainText('no meter');
  await audit(page);
  await page.locator('#documentsConfirmed').check();
  await draw(page);
  await page.locator('#authorizeJob').click();
  await expect(page.locator('#saveStatus')).toHaveText('Signed');
  await expect.poll(() => page.evaluate(() => state.photoUrls.size)).toBe(1);
  const urls = await page.evaluate(() => {
    window.revokedUrls = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => {
      window.revokedUrls.push(url);
      revoke(url);
    };
    return [...state.photoUrls.values()];
  });
  await menu(page, 'jobMenu');
  await page.locator('#openJobs').click();
  await page.locator('.job-link').filter({ hasText: 'Draft to reopen' }).click();
  await expect(page.locator('#address')).toHaveValue('Draft to reopen');
  expect(await page.evaluate(() => [state.photoUrls.size, window.revokedUrls])).toEqual([
    0,
    expect.arrayContaining(urls),
  ]);
});

async function photoDraft(page) {
  await scope(page);
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 600;
    return c.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({
    name: 'synthetic.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
  await expect(page.locator('#photoCount')).toContainText('1 photos');
  await expect(page.locator('#photoGallery')).toContainText('no meter');
  const id = await page.evaluate(async () => {
    const rows = await (
      await fetch('/api/inspections', {
        headers: { Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid') },
      })
    ).json();
    return rows.inspections.find((r) => r.address === 'Synthetic browser property').inspection_id;
  });
  return { id, image };
}
async function restoreCloudOnly(page, id) {
  await menu(page, 'jobMenu');
  await page.locator('#newInspection').click();
  await expect(page.locator('#jobMenu')).not.toHaveAttribute('open');
  // The old draft is written back before the new form is filled; wait for the blank form.
  await expect(page.locator('#address')).toHaveValue('');
  await page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('adr-private-drafts-v2');
        request.onsuccess = () => {
          const tx = request.result.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').delete(sessionStorage.getItem('synthetic-uid') + ':' + id);
          tx.oncomplete = resolve;
          tx.onerror = reject;
        };
      }),
    id,
  );
  await menu(page, 'jobMenu');
  await page.locator('#openJobs').click();
  await page.locator('.job-link').filter({ hasText: 'Synthetic browser property' }).click();
  await task(page, 'walkthrough');
  await expect(page.locator('#photoGallery img')).toHaveCount(1);
  await expect
    .poll(() => page.locator('#photoGallery img').evaluate((el) => el.naturalWidth))
    .toBe(300);
}
test('cloud-restored originals survive photo-backed conflict fork', async ({ page }) => {
  const { id } = await photoDraft(page);
  await restoreCloudOnly(page, id);
  await page.evaluate(async (id) => {
    const headers = {
      Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid'),
      'Content-Type': 'application/json',
    };
    const r = await (await fetch('/api/inspections/' + id, { headers })).json();
    r.data.technician_notes = 'Other device changed the scope';
    await fetch('/api/inspections/' + id, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expected_revision: r.revision, data: r.data }),
    });
  }, id);
  await task(page, 'property');
  await page.locator('#technicianNotes').fill('Keep this device work and photo');
  await saveDraft(page);
  await expect(page.locator('#conflictActions')).toBeVisible();
  await page.locator('#forkLocal').click();
  await expect(page.locator('#conflictActions')).toBeHidden();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#technicianNotes')).toHaveValue('Keep this device work and photo');
  await task(page, 'walkthrough');
  await expect
    .poll(() => page.locator('#photoGallery img').evaluate((el) => el.naturalWidth))
    .toBe(300);
});
test('reopened local draft merges photos added by another device', async ({ page }) => {
  const { id, image } = await photoDraft(page);
  await page.evaluate(
    async ({ id, image }) => {
      const headers = {
        Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid'),
        'Content-Type': 'application/json',
      };
      const r = await (await fetch('/api/inspections/' + id, { headers })).json();
      const response = await fetch('/api/inspections/' + id + '/photos', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          photo_id: 'd'.repeat(32),
          expected_revision: r.revision,
          room: r.data.rooms[0].name,
          captured_at: new Date().toISOString(),
          data_url: image,
        }),
      });
      if (!response.ok) throw Error(await response.text());
      await fetch('/api/inspections/' + id + '/photos/' + 'd'.repeat(32) + '/ocr', {
        method: 'POST',
        headers,
        body: '{}',
      });
    },
    { id, image },
  );
  await page.reload();
  await task(page, 'walkthrough');
  await expect(page.locator('#photoGallery img')).toHaveCount(2);
  await expect
    .poll(() =>
      page
        .locator('#photoGallery img')
        .evaluateAll((images) => images.every((img) => img.naturalWidth === 300)),
    )
    .toBe(true);
});
test('cloud-restored photos remain visible after offline reload', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit (Windows and Linux) fails offline service-worker navigation with an internal error; physical iPhone acceptance remains open.',
  );
  const { id } = await photoDraft(page);
  await restoreCloudOnly(page, id);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
      );
  });
  await context.setOffline(true);
  await page.reload();
  await task(page, 'walkthrough');
  await expect
    .poll(() => page.locator('#photoGallery img').evaluate((el) => el.naturalWidth))
    .toBe(300);
});
test('saved jobs list is newest first and loads older signed jobs', async ({ page }) => {
  await page.evaluate(async () => {
    const response = await fetch('/__test/seed-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: sessionStorage.getItem('synthetic-uid') }),
    });
    if (!response.ok) throw Error('Synthetic seed failed');
  });
  await menu(page, 'jobMenu');
  await page.locator('#openJobs').click();
  const signed = page.locator('.job-link').filter({ hasText: 'Synthetic signed job' });
  await expect(signed).toHaveCount(100);
  await expect(signed.first()).toContainText('job 104');
  await expect(signed.last()).toContainText('job 005');
  await page.getByRole('button', { name: 'Load older signed jobs' }).click();
  await expect(signed).toHaveCount(105);
  await expect(signed.last()).toContainText('job 000');
  await expect(page.getByRole('button', { name: 'Load older signed jobs' })).toBeHidden();
});

for (const failure of ['evidence', 'record'])
  test('durable signing receipt survives ' + failure + ' display failure', async ({ page }) => {
    await audit(page);
    await page.locator('#documentsConfirmed').check();
    await draw(page);
    await fault(page, { [failure]: 1 });
    await page.locator('#authorizeJob').click();
    await expect(page.locator('#saveStatus')).toHaveText('Signed');
    await expect(page.locator('#retrySavedEvidence')).toBeVisible();
    await expect(page.locator('#message')).toContainText('saved');
    await expect(page.locator('#address')).toBeDisabled();
    await page.locator('#retrySavedEvidence').click();
    await expect(page.locator('#savedSignature')).toBeVisible();
    await expect(page.locator('#retrySavedEvidence')).toBeHidden();
    const { references } = await fault(page, {});
    expect(references).toHaveLength(1);
  });

test('walkthrough form fill auto-applies quoted values, supports Undo and invalidates old documents', async ({
  page,
}) => {
  await audit(page);
  await task(page, 'walkthrough');
  await page.locator('details:has(#technicianTranscript) summary').click();
  await page
    .locator('#technicianTranscript')
    .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await page.locator('#fillScope').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await expect(page.locator('#airMovers')).toHaveValue('3');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await expect(page.locator('#scopeQuestions')).toContainText('Confirm any additional labor.');
  await page
    .locator('#airMovers')
    .locator('..')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await expect(page.locator('[data-room-key="category"]')).toHaveValue('2');
  await expect(page.locator('#airMovers')).toHaveValue('0');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await expect(page.locator('#documents')).toBeHidden();
  await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.reload();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#itemizedTotal')).toHaveText('$1,411.40');
});

test('scope suggestions dismiss and manual edits preserve user values', async ({ page }) => {
  await page
    .locator('#technicianNotes')
    .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.locator('#dismissScopeSuggestions').click();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.locator('#airMovers').fill('6');
  await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
  await expect(page.locator('#airMovers')).toHaveValue('6');
});

test('a dehumidifier typed after a blocked audit and walkthrough detour replaces the 0 and is priced', async ({
  page,
}) => {
  // The 2026-10-17 phone test: a prefilled 0 left the caret after it, so typing 1 showed "01".
  await page.setViewportSize({ width: 390, height: 844 });
  await task(page, 'walkthrough');
  await page.locator('details:has(#technicianTranscript) summary').click();
  await page
    .locator('#technicianTranscript')
    .fill('Room 1, clean water. Set one dehumidifier for 3 days.');
  await scope(page);
  const blocked = page.waitForResponse((r) => r.url().endsWith('/api/audit'));
  await page.locator('#finishAudit').click();
  const first = (await (await blocked).json()).audit.documents;
  expect(first.signable).toBe(false);
  expect(first.unpriced_work).toHaveLength(1);
  await task(page, 'property');
  await page.locator('#panel-property .section-head [data-task="walkthrough"]').click();
  await expect(page.locator('#panel-walkthrough')).toBeVisible();
  await task(page, 'property');
  const box = page.locator('#dehumidifiers');
  await expect(box).toHaveValue('0');
  await expect(box).toHaveAttribute('inputmode', 'numeric');
  await expect(page.locator('#laborHours')).toHaveAttribute('inputmode', 'decimal');
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveAttribute(
    'inputmode',
    'decimal',
  );
  const saves = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/inspections/')) saves.push(r.postDataJSON());
  });
  await expect(page.locator('#scopeConfirmNotice')).toBeHidden();
  await box.click();
  await page.keyboard.type('1');
  await expect(box).toHaveValue('1');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await expect(page.locator('#scopeConfirmNotice')).toHaveText('Scope changed · confirm again.');
  await page.locator('#scopeConfirmed').check();
  await expect(page.locator('#scopeConfirmNotice')).toBeHidden();
  const audited = page.waitForResponse((r) => r.url().endsWith('/api/audit'));
  // Inside the 1.5 s save debounce: Finish & review must flush the pending save itself.
  expect(saves).toHaveLength(0);
  await page.locator('#finishAudit').click();
  const documents = (await (await audited).json()).audit.documents;
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.map((body) => body.data.dehumidifiers)).toEqual(saves.map(() => 1));
  expect(documents.unpriced_work).toEqual([]);
  expect(documents.signable).toBe(true);
  expect(documents.xactimate_scope.find((item) => item.code === 'ADR-DEHU')).toMatchObject({
    quantity: 3,
  });
});

test.describe('controlled scope requests', () => {
  test.use({ serviceWorkers: 'block' });

  test('delayed scope results cannot overwrite manual edits', async ({ page }) => {
    let release, started;
    const gate = new Promise((resolve) => (release = resolve)),
      requestStarted = new Promise((resolve) => (started = resolve));
    await page.route('**/scope-suggestions', async (route) => {
      started();
      await gate;
      await route.continue();
    });
    try {
      await page
        .locator('#technicianNotes')
        .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
      await page.locator('#fillScopeProperty').click();
      await requestStarted;
      await page.locator('#airMovers').fill('6');
      release();
      await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');
      await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
      await expect(page.locator('#airMovers')).toHaveValue('6');
      await expect(page.locator('#message')).toContainText(/changed/);
    } finally {
      release();
    }
  });

  test('fill scope stops active capture before showing reviewable changes', async ({ page }) => {
    test.skip(
      !(await page.evaluate(() => !!(window.AudioContext || window.webkitAudioContext))),
      'Windows WebKit has no Web Audio; physical iPhone capture cleanup remains open.',
    );
    await page
      .locator('#technicianNotes')
      .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const videoTracks = canvas.captureStream ? canvas.captureStream(1).getVideoTracks() : [];
      canvas.getContext('2d').fillRect(0, 0, 640, 480);
      if (!videoTracks.length) document.getElementById('cameraVideo').play = async () => {};
      const audio = new (window.AudioContext || window.webkitAudioContext)(),
        destination = audio.createMediaStreamDestination();
      window.syntheticInputAudio = audio;
      window.syntheticTracks = [...videoTracks, ...destination.stream.getAudioTracks()];
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => new MediaStream(window.syntheticTracks) },
      });
      window.WebSocket = class {
        static OPEN = 1;
        readyState = 0;
        bufferedAmount = 0;
        constructor() {
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.();
          }, 0);
        }
        send(message) {
          if (JSON.parse(message).type === 'authenticate')
            setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }), 0);
        }
        close() {
          this.readyState = 3;
          this.onclose?.();
        }
      };
    });
    await task(page, 'walkthrough');
    await page.locator('#startWalk').click();
    await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
    await page.locator('#fillScope').click();
    await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.syntheticTracks.every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);
    expect(await page.locator('#cameraVideo').evaluate((el) => el.srcObject === null)).toBe(true);
    await expect(page.locator('#liveStatus')).toHaveText('Not connected');
    await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
    await page.evaluate(() => window.syntheticInputAudio.close());
  });

  test('scope results from a previous inspection are discarded', async ({ page }) => {
    let release, started;
    const gate = new Promise((resolve) => (release = resolve)),
      requestStarted = new Promise((resolve) => (started = resolve));
    await page.route('**/scope-suggestions', async (route) => {
      started();
      await gate;
      await route.continue();
    });
    try {
      await page
        .locator('#technicianNotes')
        .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
      await page.locator('#fillScopeProperty').click();
      await requestStarted;
      await menu(page, 'jobMenu');
      await page.locator('#newInspection').click();
      await expect(page.locator('#technicianNotes')).toHaveValue('');
      release();
      await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');
      await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
      await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
    } finally {
      release();
    }
  });
});
