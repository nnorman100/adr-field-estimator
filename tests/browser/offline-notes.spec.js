const { test, expect } = require('@playwright/test');
// Offline notes: the record-now, process-later option for bad reception. MediaRecorder is replaced
// by a stub that emits MP4-signed slices, so recording is deterministic in every browser; a physical
// iPhone recording, screen lock and Bluetooth microphone remain open until observed on a device.
async function fakeRecorder(page) {
  await page.addInitScript(() => {
    window.noteTracks = [];
    const head = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypM4A mp42')]);
    window.MediaRecorder = class {
      static isTypeSupported(type) {
        return type === 'audio/mp4';
      }
      constructor(stream, options) {
        this.stream = stream;
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
          window.noteTracks.push(track);
          return { getTracks: () => [track] };
        },
      },
    });
  });
}
async function ready(page) {
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.locator('.task-nav [data-task="property"]').click();
}
async function walkthrough(page) {
  await page.locator('.task-nav [data-task="walkthrough"]').click();
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

test('offline notes record on the phone, survive a reload, then fill the transcript and scope with missing items', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit offline emulation also blocks in-memory Blob reads, so notes cannot be saved offline in this harness; physical iPhone acceptance remains open.',
  );
  await fakeRecorder(page);
  await page.goto('/app');
  await ready(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
      );
  });
  const id = await page.evaluate(() => state.draft.inspection_id);
  await walkthrough(page);
  await page.locator('#startNotes').click();
  await expect(page.locator('#offlineNotes')).toBeVisible();
  await expect(page.locator('#startWalk')).toBeHidden();
  await expect(page.locator('.viewfinder')).toBeHidden();
  await expect(page.locator('#backToLive')).toBeEnabled();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const control of [
      '#recordNote',
      '#backToLive',
      '#addTypedNote',
      '#takePhoto',
      '#uploadPhoto',
    ])
      await expect(page.locator(control)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    if (browserName === 'chromium')
      await page.screenshot({
        path: test.info().outputPath('offline-notes-' + width + '.png'),
        fullPage: true,
      });
  }

  await context.setOffline(true);
  await expect(page.locator('#backToLive')).toBeDisabled();
  await page.locator('#recordNote').click();
  await expect(page.locator('#recordingStatus')).toContainText('Recording · Room 1 · 0:0');
  await expect(page.locator('#recordNote')).toHaveText('Stop and save note');
  await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
  await page.locator('#recordNote').click();
  await expect(page.locator('#recordingStatus')).toHaveText(
    'Voice note saved on this phone · Room 1.',
  );
  expect(await page.evaluate(() => window.noteTracks.every((t) => t.readyState === 'ended'))).toBe(
    true,
  );
  await expect(page.locator('#voiceNotes li')).toHaveCount(1);
  await expect(page.locator('#voiceNotes li')).toContainText(
    'Saved on this phone · uploads when online',
  );
  await expect(page.locator('#notesQueue')).toHaveText(
    '1 voice note waiting to upload. They upload when you have signal.',
  );
  await page.locator('#typedNote').fill('Use 3 fans.');
  await page.locator('#addTypedNote').click();
  await expect(page.locator('#technicianNotes')).toHaveValue('Room 1: Use 3 fans.');
  await expect(page.locator('#typedNote')).toHaveValue('');

  // A reload during a recording keeps every slice already saved on the phone.
  await page.locator('#recordNote').click();
  await expect(page.locator('#recordingStatus')).toContainText('Recording');
  const before = await savedParts(page);
  await expect.poll(() => savedParts(page)).toBeGreaterThan(before + 1);
  await page.reload();
  await expect(page.locator('#technicianNotes')).toHaveValue('Room 1: Use 3 fans.', {
    timeout: 15000,
  });
  await walkthrough(page);
  await expect(page.locator('#voiceNotes li')).toHaveCount(2);
  await expect(page.locator('#notesQueue')).toHaveText(
    '2 voice notes waiting to upload. They upload when you have signal.',
  );

  // Back online: both notes upload, join the transcript, and the scope fill lists what is missing.
  await context.setOffline(false);
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#technicianTranscript')).toHaveValue(
    /^\[Offline voice note [0-9a-f]{8} · Room 1 · recorded .+ · transcribed later\]\nRoom 1, category 2, 80 square feet of drywall\.\n\[Offline voice note [0-9a-f]{8} · Room 1 · recorded .+ · transcribed later\]\nRoom 1, category 2, 80 square feet of drywall\.\n$/,
  );
  await expect(page.locator('#scopeGapsHeading')).toBeVisible();
  await expect(page.locator('#scopeMissing li')).toHaveText([
    'No property address',
    'No year built',
    'Room 1: 3 photo shots missing (Room overview, Affected wall or floor, Meter reading) · set how many: affected walls or floors, wet materials',
  ]);
  await expect(page.locator('#scopeQuestions li')).toHaveText(['Confirm any additional labor.']);
  await walkthrough(page);
  await expect(page.locator('#voiceNotes li')).toHaveCount(2);
  for (const item of await page.locator('#voiceNotes li').all())
    await expect(item).toContainText('Added to the walkthrough transcript');
  await expect(page.locator('#notesQueue')).toHaveText('All voice notes and photos are uploaded.');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  // The server kept the transcript text only; the phone keeps the audio for replay.
  const uid = await page.evaluate(() => sessionStorage.getItem('synthetic-uid'));
  const remote = await (
    await page.request.get('/api/inspections/' + id, {
      headers: { Authorization: 'Bearer ' + uid },
    })
  ).json();
  expect(remote.data.technician_transcript.match(/\[Offline voice note/g)).toHaveLength(2);
  expect(JSON.stringify(remote)).not.toContain('audio');
  expect(await savedParts(page)).toBeGreaterThan(3);
});

test('a weak Live connection offers offline notes without switching, and the technician can go back to Live', async ({
  page,
  browserName,
}) => {
  await page.goto('/app');
  await ready(page);
  test.skip(
    !(await page.evaluate(() => !!(window.AudioContext || window.webkitAudioContext))) ||
      browserName === 'webkit',
    'Playwright WebKit never starts the synthetic microphone stream; physical iPhone acceptance remains open.',
  );
  await page.evaluate(() => {
    window.liveSockets = [];
    window.liveTracks = [];
    window.syntheticContexts = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const canvas = document.createElement('canvas');
          canvas.getContext('2d').fillRect(0, 0, 300, 150);
          const audio = new AudioContext();
          window.syntheticContexts.push(audio);
          const tracks = [
            ...canvas.captureStream(1).getVideoTracks(),
            ...audio.createMediaStreamDestination().stream.getAudioTracks(),
          ];
          window.liveTracks.push(...tracks);
          return new MediaStream(tracks);
        },
      },
    });
    // A relay that announces acknowledgements but never sends one: Live shows the weak signal.
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      constructor() {
        window.liveSockets.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 0);
      }
      emit(packet) {
        this.onmessage?.({ data: JSON.stringify(packet) });
      }
      send(raw) {
        const packet = JSON.parse(raw);
        if (packet.type === 'authenticate')
          setTimeout(
            () =>
              this.emit({
                type: 'ready',
                protocol_version: 2,
                connection_id: 'synthetic-' + window.liveSockets.length,
                recovery: packet.resume ? 'resumed' : 'new',
                audio_ack: 10,
              }),
            0,
          );
        if (packet.type === 'end')
          setTimeout(() => this.emit({ type: 'finished', complete: true }));
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    };
  });
  await walkthrough(page);
  await page.locator('#startWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText(
    'Weak signal: video paused, voice may be delayed',
  );
  await page.evaluate(() =>
    window.liveSockets[0].emit({
      type: 'transcript',
      speaker: 'technician',
      connection_id: 'synthetic-1',
      sequence: 1,
      text: 'Kitchen category 1.',
      finished: true,
    }),
  );
  await expect(page.locator('#technicianTranscript')).toHaveValue('Kitchen category 1.');
  await expect(page.locator('#offlineOffer')).toBeHidden();
  // The weak state has lasted 25 seconds: the app offers offline notes and keeps Live running.
  const weakFor = (ms) => page.evaluate((age) => (state.poorSince = performance.now() - age), ms);
  await weakFor(20000);
  await page.waitForTimeout(2500);
  await expect(page.locator('#offlineOffer')).toBeHidden();
  await weakFor(26000);
  await expect(page.locator('#offlineOffer')).toBeVisible();
  await expect(page.locator('#offlineOfferText')).toHaveText(
    'Reception has been weak for a while. Switch to offline notes? What Live already captured is kept.',
  );
  await expect(page.locator('#stopWalk')).toBeVisible();
  await expect(page.locator('#offlineNotes')).toBeHidden();
  // Declining keeps Live and is not asked again until the signal recovers.
  await page.locator('#declineOffline').click();
  await expect(page.locator('#offlineOffer')).toBeHidden();
  await weakFor(60000);
  await page.waitForTimeout(2500);
  await expect(page.locator('#offlineOffer')).toBeHidden();
  await expect(page.locator('#liveStatus')).toHaveClass('status weak');
  await page.evaluate(() => (state.offerDeclined = false));
  await weakFor(26000);
  await expect(page.locator('#offlineOffer')).toBeVisible();
  await page.locator('#acceptOffline').click();
  await expect(page.locator('#offlineNotes')).toBeVisible();
  await expect(page.locator('#offlineOffer')).toBeHidden();
  await expect(page.locator('#liveStatus')).toHaveText('Not connected');
  expect(
    await page.evaluate(() => window.liveTracks.every((track) => track.readyState === 'ended')),
  ).toBe(true);
  await expect(page.locator('#technicianTranscript')).toHaveValue('Kitchen category 1.');
  await page.locator('#backToLive').click();
  await expect(page.locator('#offlineNotes')).toBeHidden();
  await expect(page.locator('#liveStatus')).toContainText(/Live conversation resumed|Weak signal/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sent = window.liveSockets.at(-1);
        return window.liveSockets.length === 2 && sent.readyState === 1;
      }),
    )
    .toBe(true);
  await page.locator('#stopWalk').click();
  await page.evaluate(() =>
    Promise.all(window.syntheticContexts.map((context) => context.close())),
  );
});

test.describe('controlled voice-note uploads', () => {
  // Requests from a service worker bypass page.route in WebKit.
  test.use({ serviceWorkers: 'block' });
  test('a note whose upload fails stays on the phone and uploads when the connection works', async ({
    page,
  }) => {
    await fakeRecorder(page);
    await page.route('**/voice-notes', (route) => route.abort());
    await page.goto('/app');
    await ready(page);
    await walkthrough(page);
    await page.locator('#startNotes').click();
    await page.locator('#typedNote').fill('Use 3 fans.');
    await page.locator('#addTypedNote').click();
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Not uploaded yet: no connection to the server, retrying',
    );
    await expect(page.locator('#notesQueue')).toHaveText('1 voice note waiting to upload.');
    await expect(page.locator('#technicianTranscript')).toHaveValue('');
    await page.unroute('**/voice-notes');
    // Reception returns: the browser reports online again and the queue drains.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Added to the walkthrough transcript',
    );
    await expect(page.locator('#technicianTranscript')).toHaveValue(
      /^\[Offline voice note [0-9a-f]{8} · Room 1 · recorded .+ · transcribed later\]\nRoom 1, category 2, 80 square feet of drywall\.\n$/,
    );
    await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
    // The note stays replayable on the phone.
    await walkthrough(page);
    await expect(page.locator('#voiceNotes button')).toHaveText('Play');
  });
  test('a note saved on the server whose response was lost does not leave the draft in a conflict', async ({
    page,
  }) => {
    await fakeRecorder(page);
    await page.route('**/voice-notes', async (route) => {
      await route.fetch();
      await route.abort();
    });
    await page.goto('/app');
    await ready(page);
    await walkthrough(page);
    await page.locator('#startNotes').click();
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Not uploaded yet: no connection to the server, retrying',
    );
    await page.locator('#typedNote').fill('Use 3 fans.');
    await page.locator('#addTypedNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Added to the walkthrough transcript',
    );
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await expect(page.locator('#conflictActions')).toBeHidden();
    await expect(page.locator('#technicianNotes')).toHaveValue('Room 1: Use 3 fans.');
    await expect(page.locator('#technicianTranscript')).toHaveValue(
      /^\[Offline voice note [0-9a-f]{8} · Room 1 · recorded .+ · transcribed later\]\nRoom 1, category 2, 80 square feet of drywall\.\n$/,
    );
  });
  test('a note the server refuses for good stops retrying, does not block later notes, and can be removed', async ({
    page,
  }) => {
    await fakeRecorder(page);
    let calls = 0;
    await page.route('**/voice-notes', (route) =>
      ++calls === 1
        ? route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'The voice note does not match its audio type.' }),
          })
        : route.continue(),
    );
    await page.goto('/app');
    await ready(page);
    await walkthrough(page);
    await page.locator('#startNotes').click();
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Could not be processed: The voice note does not match its audio type. Play it, type the key facts, then remove it.',
    );
    await expect(page.locator('#notesQueue')).toHaveText(
      'All voice notes and photos are uploaded.',
    );
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(3);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li').nth(1)).toContainText(
      'Added to the walkthrough transcript',
    );
    const failed = page.locator('#voiceNotes li').first();
    await expect(failed).toContainText('Could not be processed');
    await expect(failed.locator('button')).toHaveText(['Play', 'Remove']);
    expect(calls).toBe(2);
    // The refused note is not pending sync: sign-out names it instead of asking to wait.
    await page.waitForFunction(() => state.session && !state.workspaceInitializing);
    if (!(await page.locator('#accountMenu').evaluate((el) => el.open)))
      await page.locator('#accountMenu summary').click();
    await page.locator('#signOutButton').click();
    await expect(page.locator('#unsyncedCount')).toHaveText(
      '1 voice note could not be processed and is kept only on this phone. Signing out removes it.',
    );
    await expect(page.locator('#googleSignIn')).toBeHidden();
    const before = await savedParts(page);
    await walkthrough(page);
    await failed.getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('#voiceNotes li')).toHaveCount(1);
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Added to the walkthrough transcript',
    );
    expect(await savedParts(page)).toBeLessThan(before);
  });
  test('a draft save the server refuses leaves the voice note waiting instead of refused', async ({
    page,
  }) => {
    await fakeRecorder(page);
    let refuse = true;
    await page.route(/\/api\/inspections\/ADR-INS-[0-9a-f]+$/, (route) =>
      refuse && route.request().method() === 'PUT'
        ? route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'Enter a valid address.' }),
          })
        : route.continue(),
    );
    await page.goto('/app');
    await ready(page);
    await walkthrough(page);
    await page.locator('#startNotes').click();
    await page.locator('#typedNote').fill('Use 3 fans.');
    await page.locator('#addTypedNote').click();
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Not uploaded yet: The draft has not saved yet: Enter a valid address.',
    );
    await expect(page.locator('#notesQueue')).toHaveText('1 voice note waiting to upload.');
    refuse = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Added to the walkthrough transcript',
    );
  });
  test('a draft save that loses its connection leaves the voice note waiting with the connection message', async ({
    page,
  }) => {
    await fakeRecorder(page);
    let drop = true;
    await page.route(/\/api\/inspections\/ADR-INS-[0-9a-f]+$/, (route) =>
      drop && route.request().method() === 'PUT' ? route.abort() : route.continue(),
    );
    await page.goto('/app');
    await ready(page);
    await walkthrough(page);
    await page.locator('#startNotes').click();
    await page.locator('#typedNote').fill('Use 3 fans.');
    await page.locator('#addTypedNote').click();
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Not uploaded yet: no connection to the server, retrying',
    );
    await expect(page.locator('#notesQueue')).toHaveText('1 voice note waiting to upload.');
    drop = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Added to the walkthrough transcript',
    );
  });
  test('a note recorded while another note uploads is not skipped', async ({ page }) => {
    await fakeRecorder(page);
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let calls = 0;
    await page.route('**/voice-notes', async (route) => {
      if (++calls === 1) await held;
      await route.continue();
    });
    await page.goto('/app');
    await ready(page);
    await walkthrough(page);
    await page.locator('#startNotes').click();
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText('Uploading and transcribing…');
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(3);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toHaveCount(2);
    await expect(page.locator('#voiceNotes li').nth(1)).toContainText('Waiting to upload');
    release();
    await expect(page.locator('#voiceNotes li').nth(0)).toContainText(
      'Added to the walkthrough transcript',
    );
    await expect(page.locator('#voiceNotes li').nth(1)).toContainText(
      'Added to the walkthrough transcript',
    );
    expect(calls).toBe(2);
    await expect(page.locator('#technicianTranscript')).toHaveValue(
      /^(\[Offline voice note [0-9a-f]{8} · Room 1 · recorded .+ · transcribed later\]\nRoom 1, category 2, 80 square feet of drywall\.\n){2}$/,
    );
  });
  test('a note recorded for one job uploads in the background while another job is open', async ({
    page,
  }) => {
    await fakeRecorder(page);
    await page.route('**/voice-notes', (route) => route.abort());
    await page.goto('/app');
    await ready(page);
    const first = await page.evaluate(() => state.draft.inspection_id);
    await walkthrough(page);
    await page.locator('#startNotes').click();
    await page.locator('#typedNote').fill('Use 3 fans.');
    await page.locator('#addTypedNote').click();
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Not uploaded yet: no connection to the server, retrying',
    );
    await page.locator('#jobMenu > summary').click();
    await page.locator('#newInspection').click();
    await expect.poll(() => page.evaluate(() => state.draft.inspection_id)).not.toBe(first);
    await ready(page);
    await page.unroute('**/voice-notes');
    // Reception returns while the second job is open.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await jsonApi('/api/inspections/' + id)).data.technician_transcript,
          first,
        ),
      )
      .toMatch(
        /^\[Offline voice note [0-9a-f]{8} · Room 1 · recorded .+ · transcribed later\]\nRoom 1, category 2, 80 square feet of drywall\.\n$/,
      );
    await expect
      .poll(() => page.evaluate(async () => (await allNotes()).map((note) => note.status)))
      .toEqual(['done']);
    // Reopening the first job shows the transcript and the note as added, with no conflict, and
    // offers one tap to read it into the scope instead of filling the scope on its own.
    await page.evaluate((id) => restoreDraft(id), first);
    await expect(page.locator('#conflictActions')).toBeHidden();
    await expect(page.locator('#technicianTranscript')).toHaveValue(/^\[Offline voice note /);
    const prompt = page.locator('#notesFillScope'),
      walkPrompt = page.locator('#notesFillScopeWalk'),
      text = '1 voice note transcribed - Fill scope and check for missing items';
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveText(text);
    await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
    // The technician on the walkthrough sees the same prompt there; tapping it opens the scope.
    await walkthrough(page);
    await expect(walkPrompt).toBeVisible();
    await expect(walkPrompt).toHaveText(text);
    await walkPrompt.click();
    await expect(page.locator('#panel-property')).toBeVisible();
    await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
    await expect(page.locator('#scopeMissing')).not.toBeEmpty();
    await expect(prompt).toBeHidden();
    await expect(walkPrompt).toBeHidden();
  });
  // Records a note on the open job while voice-note uploads fail, then opens a new job.
  async function noteForOtherJob(page, reception = () => {}) {
    await fakeRecorder(page);
    const fail = (route) => route.abort();
    await page.route('**/voice-notes', fail);
    await page.goto('/app');
    await ready(page);
    const first = await page.evaluate(() => state.draft.inspection_id);
    await walkthrough(page);
    await page.locator('#startNotes').click();
    await page.locator('#typedNote').fill('Use 3 fans.');
    await page.locator('#addTypedNote').click();
    await page.locator('#recordNote').click();
    await expect.poll(() => savedParts(page)).toBeGreaterThan(1);
    await page.locator('#recordNote').click();
    await expect(page.locator('#voiceNotes li')).toContainText('Not uploaded yet');
    await page.locator('#jobMenu > summary').click();
    await page.locator('#newInspection').click();
    await expect.poll(() => page.evaluate(() => state.draft.inspection_id)).not.toBe(first);
    await ready(page);
    await page.waitForFunction(() => !drainingQueue);
    await reception(first);
    await page.unroute('**/voice-notes', fail);
    return first;
  }
  const transcriptOf = (page, id) =>
    page.evaluate(
      async (id) => (await jsonApi('/api/inspections/' + id)).data.technician_transcript,
      id,
    );
  const noteBlock =
    /^\[Offline voice note [0-9a-f]{8} · Room 1 · recorded .+ · transcribed later\]\nRoom 1, category 2, 80 square feet of drywall\.\n$/;
  test('a note interrupted while recording on another job still uploads in the background', async ({
    page,
  }) => {
    const first = await noteForOtherJob(page);
    // The page was killed mid-recording: the stored note is still marked as recording.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open('adr-private-drafts-v2');
          request.onsuccess = () => {
            const store = request.result.transaction('notes', 'readwrite').objectStore('notes');
            const all = store.getAll();
            all.onsuccess = () => {
              for (const note of all.result) store.put({ ...note, status: 'recording' });
              store.transaction.oncomplete = () => {
                request.result.close();
                resolve();
              };
            };
          };
        }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => transcriptOf(page, first)).toMatch(noteBlock);
    await expect
      .poll(() => page.evaluate(async () => (await allNotes()).map((note) => note.status)))
      .toEqual(['done']);
  });
  test('opening a job while its note uploads in the background does not send the note twice', async ({
    page,
  }) => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let calls = 0;
    const first = await noteForOtherJob(page, () =>
      page.route('**/voice-notes', async (route) => {
        calls++;
        await held;
        await route.continue();
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => calls).toBe(1);
    await page.evaluate((id) => restoreDraft(id), first);
    await walkthrough(page);
    await expect(page.locator('#voiceNotes li')).toHaveCount(1);
    release();
    await expect(page.locator('#voiceNotes li')).toContainText(
      'Added to the walkthrough transcript',
    );
    await expect(page.locator('#technicianTranscript')).toHaveValue(noteBlock);
    await expect(page.locator('#conflictActions')).toBeHidden();
    // The note reached the open job, so its scope is read as if the job had sent it.
    await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
    await expect(page.locator('#notesFillScope')).toBeHidden();
    expect(calls).toBe(1);
  });
  test('a background sync that loses its connection retries so the other job’s note still uploads', async ({
    page,
  }) => {
    await page.clock.install();
    let other;
    const first = await noteForOtherJob(page, (id) => {
      other = new RegExp('/api/inspections/' + id + '$');
      return page.route(other, (route) => route.abort());
    });
    // The queue's next attempt loses its connection while the browser still reports online.
    await page.clock.fastForward(61000);
    await expect(page.locator('#message')).toContainText(
      'Some queued drafts still need synchronization',
    );
    await page.unroute(other);
    await page.clock.fastForward(61000);
    await expect.poll(() => transcriptOf(page, first)).toMatch(noteBlock);
  });
});
