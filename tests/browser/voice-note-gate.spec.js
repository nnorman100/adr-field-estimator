const { saveDraft } = require('./actions');
const { test, expect } = require('@playwright/test');
// A service worker would bypass page.route in WebKit. These flows hold or reject transcription.
test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);

async function fakeRecorder(page) {
  await page.addInitScript(() => {
    const head = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypM4A mp42')]);
    window.MediaRecorder = class {
      static isTypeSupported(type) {
        return type === 'audio/mp4';
      }
      constructor(_stream, options) {
        this.mimeType = options.mimeType;
        this.state = 'inactive';
        this.first = true;
      }
      emit() {
        const part = this.first ? head : new Uint8Array(64).fill(7);
        this.first = false;
        this.ondataavailable?.({ data: new Blob([part], { type: 'audio/mp4' }) });
      }
      start() {
        this.state = 'recording';
        this.timer = setInterval(() => this.emit(), 150);
      }
      requestData() {
        this.emit();
      }
      stop() {
        clearInterval(this.timer);
        this.emit();
        this.state = 'inactive';
        setTimeout(() => this.onstop?.(), 0);
      }
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const track = { readyState: 'live', stop: () => (track.readyState = 'ended') };
          return { getTracks: () => [track] };
        },
      },
    });
  });
}
async function ready(page) {
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function task(page, name) {
  await page.locator('.task-nav [data-task="' + name + '"]').click();
}
const savedParts = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open('adr-private-drafts-v2');
        request.onsuccess = () => {
          const all = request.result.transaction('note_audio').objectStore('note_audio').getAll();
          all.onsuccess = () => {
            resolve(all.result.length);
            request.result.close();
          };
        };
      }),
  );
async function deskFinish(page) {
  await task(page, 'property');
  await page.locator('#address').fill('Synthetic voice-note gate');
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#technicianNotes').fill('Use 3 fans.');
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#scopeConfirmed')).toBeChecked();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
}
async function recordOne(page) {
  await task(page, 'walkthrough');
  await page.locator('#startNotes').click();
  await page.locator('#recordNote').click();
  await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
  await page.locator('#recordNote').click();
}
async function draw(page) {
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 30, rect.y + 40);
  await page.mouse.down();
  await page.mouse.move(rect.x + 110, rect.y + 100, { steps: 8 });
  await page.mouse.move(rect.x + 220, rect.y + 30, { steps: 8 });
  await page.mouse.up();
}
async function signOnDevice(page) {
  await page.locator('#documentsConfirmed').check();
  await draw(page);
  await page.locator('#authorizeJob').click();
  await expect(page.locator('#saveStatus')).toHaveText('Signed');
}
const FAILED =
  'Could not be processed: The voice note does not match its audio type. Play it, type the key facts, then remove it.';

test('a delayed transcription holds Finish, a signing link and on-device signing until the transcript is reviewed', async ({
  page,
}) => {
  await fakeRecorder(page);
  await page.goto('/app');
  await ready(page);
  await deskFinish(page);
  let audits = 0;
  await page.route('**/api/audit', async (route) => {
    if (route.request().method() === 'POST') audits++;
    await route.continue();
  });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route(/\/api\/inspections\/[^/]+\/voice-notes$/, async (route) => {
    await held;
    await route.continue();
  });
  await recordOne(page);
  await expect(page.locator('#voiceNotes li')).toContainText('Uploading and transcribing');
  await page.locator('#finishAudit').click();
  await expect(page.locator('#message')).toContainText('Saving and transcribing voice notes');
  expect(audits).toBe(0);
  release();
  await expect(page.locator('#message')).toContainText('Review the voice-note transcript');
  await expect(page.locator('#technicianTranscript')).toHaveValue(/Room 1, category 2/);
  await expect(page.locator('#documents')).toBeHidden();
  expect(audits).toBe(0);
  await page.reload();
  await ready(page);
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await task(page, 'walkthrough');
  await expect(page.locator('#voiceNotes li')).toHaveCount(1);
  expect(await savedParts(page)).toBeGreaterThan(0);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#message')).toContainText('Review the voice-note transcript');
  expect(audits).toBe(0);
  await expect(page.locator('#reviewVoiceNotesWalk')).toBeVisible();
  await page.locator('#reviewVoiceNotesWalk').click();
  await expect(page.locator('#message')).toContainText('Transcript reviewed.');
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeHidden();
  expect(audits).toBe(0);
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await task(page, 'property');
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.locator('#confirmFilledScope').click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  expect(audits).toBe(1);
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkPanel')).toBeVisible();
  await signOnDevice(page);
});

test('a failed transcription blocks Finish and signing until the technician resolves it, and survives a reload', async ({
  page,
  context,
}) => {
  await fakeRecorder(page);
  await page.goto('/app');
  await ready(page);
  await deskFinish(page);
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkPanel')).toBeVisible();
  const id = await page.evaluate(() => state.draft.inspection_id);
  // The audio reaches the server with a body that is not the declared type, so the note is
  // marked failed there. Reserving it is a different URL and still runs.
  await page.route(/\/api\/inspections\/[^/]+\/voice-notes$/, async (route) => {
    const body = route.request().postDataJSON();
    body.audio_base64 = Buffer.from('not-an-mp4-audio!!').toString('base64');
    const response = await route.fetch({
      postData: JSON.stringify(body),
      headers: { ...route.request().headers(), 'content-type': 'application/json' },
    });
    await route.fulfill({ response });
  });
  let resolves = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/voice-notes\/[a-f0-9]{32}\/resolve$/.test(request.url()))
      resolves++;
  });
  await recordOne(page);
  await expect(page.locator('#voiceNotes li')).toContainText(FAILED);
  await expect(page.locator('#documents')).toBeHidden();
  await expect(page.locator('#sendHomeownerLink')).toBeDisabled();
  await expect(page.locator('#authorizeJob')).toBeDisabled();
  const uid = await page.evaluate(() => sessionStorage.getItem('synthetic-uid'));
  const link = await page.request.get('/api/inspections/' + id + '/signing-links', {
    headers: { Authorization: 'Bearer ' + uid },
  });
  expect((await link.json()).status).toBe('revoked');
  await page.locator('#finishAudit').click();
  await expect(page.locator('#message')).toContainText(
    'Play it, type the key facts, then remove it.',
  );
  await page.reload();
  await ready(page);
  await task(page, 'walkthrough');
  await expect(page.locator('#voiceNotes li')).toContainText(FAILED);
  expect(await savedParts(page)).toBeGreaterThan(0);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#message')).toContainText(
    'Play it, type the key facts, then remove it.',
  );
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  const retainedParts = await savedParts(page);
  await page.locator('#voiceNotes li').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#message')).toContainText('requires a connection');
  await expect(page.locator('#voiceNotes li')).toHaveCount(1);
  expect(await savedParts(page)).toBe(retainedParts);
  expect(resolves).toBe(0);
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await page.locator('#voiceNotes li').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#voiceNotes li')).toHaveCount(0);
  expect(resolves).toBe(1);
  await task(page, 'property');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkPanel')).toBeVisible();
  await signOnDevice(page);
});

test('an outstanding homeowner link blocks offline voice recording and survives reload', async ({
  page,
  context,
}) => {
  await fakeRecorder(page);
  await page.goto('/app');
  await ready(page);
  await deskFinish(page);
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkPanel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => state.draft.homeowner_link_pending)).toBe(true);
  await page.reload();
  await ready(page);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await task(page, 'walkthrough');
  await page.locator('#startNotes').click();
  await page.locator('#recordNote').click();
  await expect(page.locator('#message')).toContainText(
    'Connect to cancel it before recording new notes.',
  );
  expect(await savedParts(page)).toBe(0);
  expect(await page.evaluate(() => !!notes.recorder)).toBe(false);
  await page.locator('#typedNote').fill('Offline observation remains available.');
  await page.locator('#addTypedNote').click();
  await expect(page.locator('#technicianNotes')).toHaveValue(
    /Offline observation remains available/,
  );
  await page.locator('#recordNote').click();
  await expect(page.locator('#message')).toContainText(
    'Connect to cancel it before recording new notes.',
  );
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await page.locator('#recordNote').click();
  await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
  expect(await page.evaluate(() => state.draft.homeowner_link_pending)).toBe(false);
  await page.locator('#recordNote').click();
});

test('a lost transcription response clears renewed scope confirmation and preserves a local correction', async ({
  page,
}) => {
  await fakeRecorder(page);
  await page.goto('/app');
  await ready(page);
  await deskFinish(page);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let arrived = false;
  await page.route(/\/api\/inspections\/[^/]+\/voice-notes$/, async (route) => {
    arrived = true;
    await held;
    await route.fetch();
    await route.abort();
  });
  await task(page, 'walkthrough');
  await page.locator('#startNotes').click();
  await page.locator('#recordNote').click();
  await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
  await task(page, 'property');
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await task(page, 'walkthrough');
  await page.locator('#recordNote').click();
  await expect.poll(() => arrived).toBe(true);
  release();
  await expect(page.locator('#voiceNotes li')).toContainText('Not uploaded yet');
  await page.locator('#typedNote').fill('Preserve this local correction: use 3 fans.');
  await page.locator('#addTypedNote').click();
  await expect(page.locator('#voiceNotes li')).toContainText('Added to the walkthrough transcript');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#conflictActions')).toBeHidden();
  await expect(page.locator('#technicianNotes')).toHaveValue(
    /Preserve this local correction: use 3 fans/,
  );
  await expect(page.locator('#technicianTranscript')).toHaveValue(/80 square feet of drywall/);
  await task(page, 'property');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
});

test('a saved inspection offers transcript review without any voice notes stored on this device', async ({
  page,
}) => {
  await fakeRecorder(page);
  await page.goto('/app');
  await ready(page);
  await recordOne(page);
  await expect(page.locator('#voiceNotes li')).toContainText('Added to the walkthrough transcript');
  await expect.poll(() => page.evaluate(() => notes.processing)).toBe(false);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('adr-private-drafts-v2');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['notes', 'note_audio'], 'readwrite');
          tx.objectStore('notes').clear();
          tx.objectStore('note_audio').clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await ready(page);
  await task(page, 'walkthrough');
  expect(await savedParts(page)).toBe(0);
  await expect(page.locator('#reviewVoiceNotesWalk')).toBeVisible();
  await page.locator('#reviewVoiceNotesWalk').click();
  await expect(page.locator('#message')).toContainText('Transcript reviewed.');
  expect(await page.evaluate(() => state.record.voice_notes.every((row) => row.reviewed))).toBe(
    true,
  );
  await expect(page.locator('#reviewVoiceNotesWalk')).toBeHidden();
});

test('a signing link sent on another device blocks offline recording without visiting Review', async ({
  page,
  browser,
}) => {
  await page.goto('/app');
  await ready(page);
  await deskFinish(page);
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkPanel')).toBeVisible();
  const id = await page.evaluate(() => state.draft.inspection_id);
  const uid = await page.evaluate(() => sessionStorage.getItem('synthetic-uid'));
  const second = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  try {
    await second.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid);
    const other = await second.newPage();
    await fakeRecorder(other);
    await other.goto(page.url());
    await ready(other);
    await other.evaluate(async (inspection) => {
      await restoreDraft(inspection);
      showTask('walkthrough', false);
    }, id);
    expect(await other.evaluate(() => state.draft.homeowner_link_pending)).toBe(true);
    await second.setOffline(true);
    await expect.poll(() => other.evaluate(() => navigator.onLine)).toBe(false);
    await other.locator('#startNotes').click();
    await other.locator('#recordNote').click();
    await expect(other.locator('#message')).toContainText(
      'Connect to cancel it before recording new notes.',
    );
    expect(await savedParts(other)).toBe(0);
    expect(await other.evaluate(() => !!notes.recorder)).toBe(false);
  } finally {
    await second.close();
  }
});
