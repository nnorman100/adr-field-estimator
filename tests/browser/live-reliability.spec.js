const { test, expect } = require('@playwright/test');
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.locator('.task-nav [data-task="property"]').click();
});
async function setup(page) {
  test.skip(
    !(await page.evaluate(() => !!(window.AudioContext || window.webkitAudioContext))),
    'Windows WebKit lacks Web Audio; physical iPhone remains open.',
  );
  await page.evaluate(() => {
    window.livePackets = [];
    window.liveSockets = [];
    window.liveTracks = [];
    window.syntheticContexts = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const canvas = document.createElement('canvas'),
            [width, height] = window.cameraSize || [640, 480];
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').fillRect(0, 0, width, height);
          const audio = new (window.AudioContext || window.webkitAudioContext)();
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
        window.livePackets.push(packet);
        // window.liveAck makes this fake relay acknowledge every 10th numbered audio packet.
        if (window.liveAck && window.autoAck && packet.type === 'audio' && packet.seq % 10 === 0)
          setTimeout(() => this.emit({ type: 'ack', seq: packet.seq }), 0);
        if (packet.type === 'authenticate')
          setTimeout(
            () =>
              this.emit({
                type: 'ready',
                protocol_version: 2,
                token_refresh: true,
                connection_id: 'synthetic-' + window.liveSockets.length,
                recovery: packet.resume ? 'resumed' : 'new',
                ...(window.liveAck ? { audio_ack: 10 } : {}),
                ...(window.shotUpdates ? { shot_updates: true } : {}),
              }),
            0,
          );
        if (packet.type === 'end')
          setTimeout(() => {
            this.emit({
              type: 'transcript',
              speaker: 'technician',
              connection_id: 'synthetic-' + window.liveSockets.length,
              sequence: 9,
              text: '80 SF',
              finished: true,
            });
            this.emit({ type: 'finished', complete: true });
          }, 30);
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    };
  });
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await page.locator('#startWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
}
async function cleanup(page) {
  await page.evaluate(() =>
    Promise.all(window.syntheticContexts.map((context) => context.close())),
  );
}
test('protocol 2 preserves fragments, deduplicates delivery and flushes before form review', async ({
  page,
}) => {
  await page
    .locator('#technicianNotes')
    .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await setup(page);
  await page.evaluate(() => {
    const socket = window.liveSockets[0],
      chunk = (sequence, text, finished) => ({
        type: 'transcript',
        speaker: 'technician',
        connection_id: 'synthetic-1',
        sequence,
        text,
        finished,
      });
    socket.emit(chunk(1, 'Bath', false));
    socket.emit(chunk(2, 'room', true));
    socket.emit(chunk(2, 'room', true));
  });
  await expect(page.locator('#technicianTranscript')).toHaveValue('Bathroom');
  await page.locator('#muteMic').click();
  expect(
    await page.evaluate(() => window.livePackets.some((packet) => packet.type === 'pause')),
  ).toBe(true);
  await page.locator('#fillScope').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(page.locator('#technicianTranscript')).toHaveValue('Bathroom\n80 SF');
  expect(
    await page.evaluate(() => window.liveTracks.every((track) => track.readyState === 'ended')),
  ).toBe(true);
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await cleanup(page);
});
test('offline requires explicit Resume and stale callbacks cannot edit a new inspection', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.syntheticOnline = false;
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => window.syntheticOnline,
    });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.locator('#startWalk')).toHaveText('Resume walkthrough');
  expect(
    await page.evaluate(() => window.liveTracks.every((track) => track.readyState === 'ended')),
  ).toBe(true);
  await page.evaluate(() => {
    window.syntheticOnline = true;
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.locator('#startWalk')).toBeEnabled();
  expect(await page.evaluate(() => window.liveSockets.length)).toBe(1);
  await page.locator('#startWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText('Live conversation resumed');
  expect(
    await page.evaluate(
      () => window.livePackets.filter((packet) => packet.type === 'authenticate').at(-1).resume,
    ),
  ).toBe(true);
  await page.locator('#jobMenu > summary').click();
  await page.locator('#newInspection').click();
  await expect(page.locator('#technicianTranscript')).toHaveValue('');
  await page.evaluate(() =>
    window.liveSockets[1].emit({
      type: 'transcript',
      speaker: 'technician',
      connection_id: 'synthetic-2',
      sequence: 100,
      text: 'LATE OLD JOB',
      finished: true,
    }),
  );
  await expect(page.locator('#technicianTranscript')).toHaveValue('');
  await cleanup(page);
});
test('Live connects when camera preview playback never settles or is rejected', async ({
  page,
}) => {
  // play() stays pending first; setup() requires Live AI connected, so a blocking await would fail here.
  await page.evaluate(() => {
    window.previewMode = 'pending';
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.id !== 'cameraVideo') return original.call(this);
      return window.previewMode === 'pending'
        ? new Promise(() => {})
        : Promise.reject(new DOMException('synthetic preview failure', 'NotAllowedError'));
    };
  });
  await setup(page);
  await expect(page.locator('#cameraEmpty')).toBeVisible();
  await expect(page.locator('#message')).toBeHidden();
  await page.locator('#stopWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText('Not connected');
  await page.evaluate(() => {
    window.previewMode = 'reject';
  });
  await page.locator('#startWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText(/Live (AI connected|conversation resumed)/);
  await expect(page.locator('#message')).toContainText(
    'Camera preview could not start: synthetic preview failure',
  );
  await expect(page.locator('#message')).toContainText('Live voice guidance continues');
  await expect(page.locator('#cameraEmpty')).toBeVisible();
  await cleanup(page);
});
test('Live connects with a forced token and renews it on the open socket without a gap', async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  const uid = await page.evaluate(() => sessionStorage.getItem('synthetic-uid'));
  expect(await page.evaluate(() => window.__testTokenRequests.at(-1))).toBe(true);
  const refreshes = () =>
    page.evaluate(() => window.livePackets.filter((packet) => packet.type === 'refresh'));
  await page.clock.fastForward(599000);
  expect(await refreshes()).toEqual([]);
  await page.clock.fastForward(1000);
  await expect.poll(refreshes).toEqual([{ type: 'refresh', token: uid }]);
  expect(await page.evaluate(() => window.__testTokenRequests.at(-1))).toBe(true);
  expect(await page.evaluate(() => window.liveSockets.length)).toBe(1);
  await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
  await page.locator('#stopWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText('Not connected');
  await page.clock.fastForward(600000);
  expect(await refreshes()).toHaveLength(1);
  await cleanup(page);
});
test('Live reconnect falls back to the cached token when the forced refresh fails', async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  const uid = await page.evaluate(() => sessionStorage.getItem('synthetic-uid'));
  await page.evaluate(() => {
    const user = auth.currentUser,
      cached = user.getIdToken;
    window.failedRefreshes = 0;
    user.getIdToken = async (force) => {
      if (force) {
        window.failedRefreshes++;
        throw Object.assign(Error('auth/network-request-failed'), {
          code: 'auth/network-request-failed',
        });
      }
      return cached(false);
    };
    window.liveSockets[0].close();
  });
  await expect(page.locator('#liveStatus')).toHaveText('Live AI disconnected');
  await page.clock.fastForward(2000);
  await expect(page.locator('#liveStatus')).toHaveText('Live conversation resumed');
  expect(await page.evaluate(() => window.liveSockets.length)).toBe(2);
  expect(await page.evaluate(() => window.failedRefreshes)).toBe(1);
  expect(
    await page.evaluate(() =>
      window.livePackets
        .filter((packet) => packet.type === 'authenticate')
        .map((packet) => packet.token),
    ),
  ).toEqual([uid, uid]);
  await expect(page.locator('#startWalk')).not.toHaveText('Resume walkthrough');
  await page.locator('#stopWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText('Not connected');
  await cleanup(page);
});
test('weak uplink: small frames wait behind queued audio, and lagging acks pause video visibly', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit never starts playing the synthetic canvas camera, so the preview has no dimensions and no Live frames to send; physical iPhone acceptance remains open.',
  );
  await page.clock.install();
  await page.evaluate(() => {
    window.cameraSize = [1920, 1080];
    window.liveAck = true;
    window.autoAck = true;
  });
  await setup(page);
  const count = (type) =>
    page.evaluate(
      (kind) => window.livePackets.filter((packet) => packet.type === kind).length,
      type,
    );
  // The clock stands still, so frames come only from runFor, which fires each acknowledgement when it
  // was due. A natural frame tick or a fastForward jump past a pending ack would make the counts race.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  // Frames are context only: at most 640 px wide and one every 2 s, so voice keeps the uplink.
  await page.clock.runFor(2000);
  await expect.poll(() => count('video')).toBe(1);
  const width = await page.evaluate(async () => {
    const frame = window.livePackets.find((packet) => packet.type === 'video');
    const blob = await (await fetch('data:image/jpeg;base64,' + frame.data)).blob();
    return (await createImageBitmap(blob)).width;
  });
  expect(width).toBe(640);
  await page.clock.runFor(2000);
  await expect.poll(() => count('video')).toBe(2);
  // A few queued microphone packets hold the next frame back while audio keeps flowing.
  await expect.poll(() => count('audio')).toBeGreaterThan(10);
  const audio = await count('audio');
  await page.evaluate(() => (window.liveSockets[0].bufferedAmount = 20000));
  await page.clock.runFor(4000);
  await expect.poll(() => count('audio')).toBeGreaterThan(audio + 5);
  expect(await count('video')).toBe(2);
  await page.evaluate(() => (window.liveSockets[0].bufferedAmount = 0));
  await page.clock.runFor(2000);
  await expect.poll(() => count('video')).toBe(3);
  expect(
    await page.evaluate(() =>
      window.livePackets
        .filter((packet) => packet.type === 'audio')
        .every((packet, index, all) => !index || packet.seq === all[index - 1].seq + 1),
    ),
  ).toBe(true);
  await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
  // Acknowledgements stop: within a second the status says so and video pauses for 10 s.
  await page.clock.resume();
  await page.evaluate(() => (window.autoAck = false));
  await expect(page.locator('#liveStatus')).toHaveText(
    'Weak signal: video paused, voice may be delayed',
  );
  await expect(page.locator('#liveStatus')).toHaveClass('status weak');
  await expect(page.locator('#liveStatus')).toHaveCSS('color', 'rgb(138, 90, 0)');
  // A frame tick may land before the lag shows, so the pause is measured from here.
  const paused = await count('video');
  // Acknowledgements resume; real time (not a clock jump) passes, so only genuine lag counts.
  await page.evaluate(() => (window.autoAck = true));
  await expect.poll(() => page.evaluate(() => state.unacked.size)).toBe(0);
  await page.waitForTimeout(3000);
  expect(await count('video')).toBe(paused);
  // Once voice keeps up again the pause expires, the status returns and frames resume.
  await expect(page.locator('#liveStatus')).toHaveText('Live AI connected', { timeout: 12000 });
  await expect.poll(() => count('video'), { timeout: 5000 }).toBe(paused + 1);
  await page.locator('#stopWalk').click();
  await expect(page.locator('#liveStatus')).toHaveText('Not connected');
  const end = await page.evaluate(() => window.livePackets.find((packet) => packet.type === 'end'));
  expect(end).toMatchObject({ type: 'end', video_pauses: 1 });
  expect(typeof end.gap_count).toBe('number');
  await cleanup(page);
});
test('an interrupted turn keeps the technician speaking on one line and rollover status stays visible', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const socket = window.liveSockets[0],
      chunk = (sequence, text) => ({
        type: 'transcript',
        speaker: 'technician',
        connection_id: 'synthetic-1',
        sequence,
        text,
        finished: null,
      });
    socket.emit(chunk(1, 'Kitchen wall is'));
    socket.emit({ type: 'interrupted' });
    socket.emit({ type: 'turn_complete' });
    socket.emit(chunk(2, ' 80 SF'));
    socket.emit({ type: 'turn_complete' });
    socket.emit(chunk(3, 'Next room'));
  });
  await expect(page.locator('#technicianTranscript')).toHaveValue(
    'Kitchen wall is 80 SF\nNext room',
  );
  await page.evaluate(() => {
    window.liveSockets[0].emit({ type: 'recovery', reason: 'rollover' });
    state.lastGap = true;
    renderSignal();
    state.lastGap = false;
    renderSignal();
  });
  await expect(page.locator('#liveStatus')).toHaveText('Refreshing Live connection…');
  await page.locator('#stopWalk').click();
  await cleanup(page);
});
test('muting after congestion clears the weak-signal status once nothing is being sent', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => (window.liveSockets[0].bufferedAmount = 200000));
  await expect(page.locator('#liveStatus')).toHaveText(
    'Weak signal: video paused, voice may be delayed',
  );
  await page.locator('#muteMic').click();
  await page.evaluate(() => (window.liveSockets[0].bufferedAmount = 0));
  await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
  await page.locator('#stopWalk').click();
  await cleanup(page);
});

async function tagNewPhoto(page) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    canvas.getContext('2d').fillRect(0, 0, 20, 20);
    return canvas.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({
    name: 'room.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
  const synced = () =>
    page.evaluate(async () => {
      await syncChain.catch(() => {});
      return state.record.photos.map((photo) => photo.shot || null);
    });
  await expect.poll(synced).toEqual([null]);
  await page.locator('#shotPickerChoices').getByRole('button', { name: 'Room overview' }).click();
  await expect.poll(synced).toEqual(['overview']);
}
const shotPackets = (page) =>
  page.evaluate(() => window.livePackets.filter((packet) => packet.type === 'shots').length);

test('a saved shot tag is announced to a relay that offers shot updates', async ({ page }) => {
  await page.evaluate(() => (window.shotUpdates = true));
  await setup(page);
  // Every ready asks for the saved status, since a tag may land while the relay is connecting.
  await expect.poll(() => shotPackets(page), { timeout: 10000 }).toBe(1);
  await tagNewPhoto(page);
  // Only the saved tag counts, after a short pause that gathers a burst of tags into one update.
  await expect.poll(() => shotPackets(page), { timeout: 10000 }).toBe(2);
  await page.locator('#shotList [data-shot-flag="equipment_placed"]').check();
  await expect.poll(() => shotPackets(page), { timeout: 10000 }).toBe(3);
  const count = page.locator('#shotList [data-shot-count="wet_materials"]');
  await count.fill('2');
  await count.blur();
  await expect.poll(() => shotPackets(page), { timeout: 10000 }).toBe(4);
  await cleanup(page);
});

test('an older relay without shot updates never receives a shot packet', async ({ page }) => {
  await setup(page);
  await tagNewPhoto(page);
  await page.waitForTimeout(3500);
  expect(await shotPackets(page)).toBe(0);
  await cleanup(page);
});
