// Drives the real ADR frontend in Chromium against the live e2e harness (live_e2e_server.py).
// Usage: node drive.js <worktree> <evidenceDir> <scenarioGroup>
const [, , WORKTREE, OUT, GROUP] = process.argv;
const { chromium } = require(WORKTREE + '/node_modules/playwright');
const BASE = 'https://localhost:8790';
const fs = require('fs');
const log = [];
const note = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  log.push(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(page, path, body) {
  return page.evaluate(
    async ([url, body]) => {
      const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
      return r.json();
    },
    [BASE + path, body],
  );
}
const push = (page, messages) => api(page, '/__e2e/push', { messages });
const audioChunk = (ms) => ({
  serverContent: {
    modelTurn: {
      parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(48 * ms, 1).toString('base64') } }],
    },
  },
});
const inText = (text) => ({ serverContent: { inputTranscription: { text } } });
const outText = (text) => ({ serverContent: { outputTranscription: { text } } });
const turnComplete = { serverContent: { turnComplete: true } };
const interrupted = { serverContent: { interrupted: true } };

async function open(browser) {
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && note('[console]', m.text()));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 1920;
          canvas.height = 1080;
          const g = canvas.getContext('2d');
          let n = 0;
          const draw = () => {
            g.fillStyle = '#4a6b8a';
            g.fillRect(0, 0, 1920, 1080);
            g.fillStyle = '#fff';
            g.font = '120px sans-serif';
            g.fillText('Synthetic camera ' + n++, 100, 500);
          };
          draw();
          setInterval(draw, 500);
          const audio = new AudioContext();
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          gain.gain.value = 0;
          osc.frequency.value = 220;
          osc.connect(gain);
          const dest = audio.createMediaStreamDestination();
          gain.connect(dest);
          osc.start();
          // window.speak(true) puts a loud tone on the synthetic microphone (relay counts it as speech).
          window.speak = (on) => (gain.gain.value = on ? 0.4 : 0);
          return new MediaStream([...canvas.captureStream(5).getVideoTracks(), ...dest.stream.getAudioTracks()]);
        },
      },
    });
  });
  await page.goto('/');
  await page.locator('#address').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#saveStatus')?.textContent.includes('Saved privately'), null, { timeout: 20000 });
  await page.locator('#address').fill('100 Synthetic Test Way, Bakersfield, CA');
  return { context, page };
}
async function start(page) {
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await page.locator('#startWalk').click();
  try {
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent === 'Live AI connected', null, { timeout: 20000 });
  } catch (e) {
    note('start failed; liveStatus=', await status(page), 'captureStatus=', await page.locator('#captureStatus').textContent(), 'walk=', await page.locator('#walkStatus, .error, [role=alert]').allTextContents());
    throw e;
  }
  note('liveStatus:', await page.locator('#liveStatus').textContent());
}
const status = (page) => page.locator('#liveStatus').textContent();
const shot = async (page, name) => {
  await page.locator('#liveStatus').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${name}.png` });
  note('screenshot', `${OUT}/${name}.png`);
};
const events = (page, since = 0) => api(page, '/__e2e/events?since=' + since);

const groups = {
  // S1 + S2: frames are 640 px / q0.5 / every 2 s; weak uplink pauses video visibly; voice keeps flowing.
  async signal(browser) {
    const { page } = await open(browser);
    await start(page);
    const t0 = Date.now() / 1000;
    await sleep(9000);
    let ev = await events(page, t0);
    const videos = ev.filter((e) => e.kind === 'video');
    const gaps = videos.slice(1).map((v, i) => +(v.t - videos[i].t).toFixed(2));
    note('S1 frames in 9 s:', videos.length, 'intervals s:', gaps, 'jpeg bytes:', videos.map((v) => v.detail.bytes));
    const dims = await page.evaluate(async (url) => {
      const b = await (await fetch(url)).blob();
      const i = await createImageBitmap(b);
      return [i.width, i.height];
    }, BASE + '/__e2e/frame/0');
    note('S1 frame dimensions at relay->Vertex:', dims);
    // Weak uplink: phone->relay delayed by 1.5 s.
    await api(page, '/__e2e/delay', { ms: 1500 });
    const weakAt = Date.now();
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent.startsWith('Weak signal'), null, { timeout: 8000 });
    note('S2 weak status after', Date.now() - weakAt, 'ms:', await status(page), '| class:', await page.locator('#liveStatus').getAttribute('class'));
    await shot(page, 'S2-weak-signal-status');
    const pauseStart = Date.now() / 1000;
    await sleep(8000);
    ev = await events(page, pauseStart + 2);
    note('S2 during weak link (8 s window, after 2 s in-flight grace): video frames reaching Vertex:', ev.filter((e) => e.kind === 'video').length, 'audio packets reaching Vertex:', ev.filter((e) => e.kind === 'audio').length);
    note('S2 status still:', await status(page), 'video_pauses:', await page.evaluate(() => state.videoPauses));
    await api(page, '/__e2e/delay', { ms: 0 });
    const healed = Date.now();
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent === 'Live AI connected', null, { timeout: 20000 });
    note('S2 status recovered', Date.now() - healed, 'ms after link healed:', await status(page));
    await shot(page, 'S2-recovered-status');
    const rec = Date.now() / 1000;
    await sleep(5000);
    ev = await events(page, rec);
    note('S2 frames in 5 s after recovery:', ev.filter((e) => e.kind === 'video').length);
    // S7 adversarial: congestion then mute -> status must not stay stuck on weak.
    await api(page, '/__e2e/delay', { ms: 1500 });
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent.startsWith('Weak signal'), null, { timeout: 8000 });
    await page.locator('#muteMic').click();
    await api(page, '/__e2e/delay', { ms: 0 });
    const muted = Date.now();
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent === 'Live AI connected', null, { timeout: 20000 });
    note('S7 muted after weak signal: status cleared', Date.now() - muted, 'ms later while still muted:', await status(page), '| mute button:', await page.locator('#muteMic').textContent());
    await shot(page, 'S7-muted-status-cleared');
    await page.locator('#muteMic').click();
    await page.locator('#stopWalk').click();
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent === 'Not connected', null, { timeout: 10000 });
  },
  // S3 + S4 + S5: transcript segments, rebuffered playback without the 5 s wipe, drain ends on a completed reply.
  async conversation(browser) {
    const { page } = await open(browser);
    await start(page);
    // Greeting (model speaks first).
    await push(page, [outText("Hi, I'm ready. What's the property address?"), audioChunk(500), audioChunk(500), turnComplete]);
    // Technician speaks a measurement in two fragments; Vertex never sets finished.
    await page.evaluate(() => window.speak(true));
    await sleep(1200);
    await page.evaluate(() => window.speak(false));
    await push(page, [inText('Kitchen wall reads'), inText(' forty percent.')]);
    await sleep(500);
    await push(page, [outText('Got it, forty percent on the kitchen wall.'), audioChunk(500), audioChunk(500), turnComplete]);
    await sleep(500);
    await page.evaluate(() => window.speak(true));
    await sleep(800);
    await push(page, [inText('Next is the hallway.')]);
    await page.evaluate(() => window.speak(false));
    await sleep(500);
    // Barge-in: model starts replying, technician talks over it, Live sends interrupted then turn_complete.
    await push(page, [outText('Okay, in the hallway'), audioChunk(500)]);
    await page.evaluate(() => window.speak(true));
    await push(page, [inText('Bathroom floor is'), interrupted, turnComplete]);
    await sleep(300);
    await push(page, [inText(' twelve square feet.')]);
    await page.evaluate(() => window.speak(false));
    await sleep(800);
    await page.locator('details:has(#technicianTranscript) summary').click();
    const tech = await page.locator('#technicianTranscript').inputValue();
    note('S4 technician transcript:', JSON.stringify(tech));
    note('S4 assistant transcript:', JSON.stringify(await page.locator('#assistantTranscript').inputValue()));
    await page.locator('#technicianTranscript').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/S4-transcript-segments.png` });
    // S5: an 8-second reply arrives in one burst (as after a network stall); the old client wiped >5 s queues.
    await push(page, [outText('Here is a long answer.'), ...Array.from({ length: 16 }, () => audioChunk(500))]);
    await sleep(400);
    const ahead1 = await page.evaluate(() => [state.audioTime - state.audio.currentTime, state.playing.size]);
    await sleep(6000);
    const ahead2 = await page.evaluate(() => [state.audioTime - state.audio.currentTime, state.playing.size]);
    note('S5 scheduled audio ahead / sources after burst:', ahead1.map((x) => +x.toFixed(2)), 'after 6 s:', ahead2.map((x) => +x.toFixed(2)));
    // A short reply after silence is held for the 0.3 s cushion, then flushed by turn_complete.
    await sleep(2500);
    await push(page, [audioChunk(100)]);
    await sleep(200);
    const held = await page.evaluate(() => [state.held.length, state.playing.size]);
    await push(page, [turnComplete]);
    await sleep(200);
    const flushed = await page.evaluate(() => [state.held.length, state.playing.size]);
    note('S5 0.1 s chunk after silence: [held, playing] =', held, 'after turn_complete:', flushed);
    // S3: final measurement then a completed reply, then Stop -> drain ends promptly and complete.
    await page.evaluate(() => window.speak(true));
    await sleep(1000);
    await page.evaluate(() => window.speak(false));
    await push(page, [inText('Last reading is dry.')]);
    await sleep(400);
    await push(page, [audioChunk(500), turnComplete]);
    await sleep(300);
    const stopAt = Date.now();
    await page.locator('#stopWalk').click();
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent === 'Not connected', null, { timeout: 10000 });
    note('S3 stop took', Date.now() - stopAt, 'ms; transcriptStatus:', await page.locator('#transcriptStatus').textContent(), '| capture status:', await page.evaluate(() => state.draft.data.capture_metadata.status));
    await page.locator('#transcriptStatus').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/S3-finish-complete.png` });
  },
  // S6 adversarial: the only completed reply was interrupted by the technician's final speech -> not complete.
  async interruptedFinish(browser) {
    const { page } = await open(browser);
    await start(page);
    await push(page, [audioChunk(500)]);
    await page.evaluate(() => window.speak(true));
    await sleep(1000);
    await page.evaluate(() => window.speak(false));
    await push(page, [interrupted, turnComplete]);
    await sleep(300);
    const stopAt = Date.now();
    await page.locator('#stopWalk').click();
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent === 'Not connected', null, { timeout: 10000 });
    note('S6 stop took', Date.now() - stopAt, 'ms; transcriptStatus:', await page.locator('#transcriptStatus').textContent(), '| capture status:', await page.evaluate(() => state.draft.data.capture_metadata.status));
    await page.locator('#transcriptStatus').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/S6-interrupted-finish-needs-review.png` });
  },
};

(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', '--host-resolver-rules=MAP alert-disaster-field-estimator-545776254070.us-west2.run.app:443 127.0.0.1:8791, EXCLUDE localhost'] });
  try {
    await groups[GROUP](browser);
  } catch (e) {
    note('ERROR', String(e && e.stack));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(`${OUT}/${GROUP}.log`, log.join('\n') + '\n');
    await browser.close();
  }
})();
