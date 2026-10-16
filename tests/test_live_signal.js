// Live playback re-buffering and the weak-signal video pause, driven with a fake clock and audio graph.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const elements = new Map();
const element = (id) => {
  if (!elements.has(id))
    elements.set(id, {
      textContent: '',
      hidden: false,
      className: '',
      classList: { toggle() {}, remove() {} },
    });
  return elements.get(id);
};
const clock = { now: 0 };
const started = [],
  stopped = [];
// 40 ms of 24 kHz PCM16, the size the relay forwards per model audio part in this test.
const chunk = Buffer.alloc(1920).toString('base64');
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
  }
  createBuffer(channels, length, rate) {
    return { duration: length / rate, copyToChannel() {} };
  }
  createBufferSource() {
    const source = {
      connect() {},
      start: (at) => started.push(at),
      stop: () => stopped.push(source),
    };
    return source;
  }
}
const context = {
  ADRCore: require('../public/core.js'),
  document: { getElementById: element, addEventListener() {} },
  navigator: { onLine: true },
  location: { href: 'https://alert-disaster-field-2026.web.app/' },
  WebSocket: class {
    static OPEN = 1;
  },
  performance: { now: () => clock.now },
  atob: (text) => Buffer.from(text, 'base64').toString('binary'),
  clearTimeout() {},
  clearInterval() {},
  setTimeout: () => {},
  URL,
  Uint8Array,
  Float32Array,
  DataView,
  console,
};
context.window = context;
vm.runInNewContext(
  fs.readFileSync('public/app.js', 'utf8') +
    ';globalThis.hooks={state,playback,flushPlayback,clearPlayback,renderSignal,acknowledged};',
  context,
);
const { state, playback, flushPlayback, renderSignal, acknowledged } = context.hooks;
const audio = new FakeAudioContext();
state.audio = audio;

// Nothing is playing: speech is held until 0.3 s is queued, then scheduled back to back.
for (let i = 0; i < 7; i++) playback(chunk);
assert.equal(started.length, 0, 'held below the 0.3 s cushion');
playback(chunk);
assert.equal(started.length, 8);
assert.ok(Math.abs(started[0] - 0.025) < 1e-9);
for (let i = 1; i < 8; i++) assert.ok(Math.abs(started[i] - started[i - 1] - 0.04) < 1e-9);
// While audio is queued, each new chunk joins the end of the queue at once.
playback(chunk);
assert.equal(started.length, 9);
assert.ok(Math.abs(started[8] - (0.025 + 0.32)) < 1e-9);
// After an underrun the cushion is rebuilt instead of playing each late chunk as a fragment.
audio.currentTime = 1;
playback(chunk);
assert.equal(started.length, 9, 'held after the queue ran dry');
// A reply shorter than the cushion still plays when its turn completes.
flushPlayback();
assert.equal(started.length, 10);
assert.ok(Math.abs(started[9] - 1.025) < 1e-9);
// A long reply that arrives far ahead of playback is never wiped (the old 5 s rule cut it off).
for (let i = 0; i < 300; i++) playback(chunk);
assert.equal(stopped.length, 0);
assert.ok(state.audioTime - audio.currentTime > 5);
console.log('PASS: Live playback holds a 0.3 s cushion after silence and never wipes a long reply');

// Weak signal: acknowledged audio more than 0.6 s behind pauses video and says so.
state.liveReady = true;
state.ackEvery = 10;
state.liveStatusText = 'Live AI connected';
clock.now = 10000;
state.unacked.set(10, clock.now);
clock.now += 200;
acknowledged(10);
renderSignal();
assert.equal(state.videoPausedUntil, 0, 'a prompt acknowledgement keeps video on');
assert.equal(element('liveStatus').textContent, '');
state.unacked.set(20, clock.now);
// No acknowledgement at all: the oldest pending packet's age alone trips the pause.
clock.now += 700;
renderSignal();
assert.equal(state.videoPausedUntil, clock.now + 10000);
assert.equal(state.videoPauses, 1);
assert.equal(element('liveStatus').textContent, 'Weak signal: video paused, voice may be delayed');
assert.equal(element('liveStatus').className, 'status weak');
// A late acknowledgement renews the same pause instead of counting a new one.
clock.now += 300;
acknowledged(20);
assert.equal(state.unacked.size, 0);
assert.equal(state.videoPauses, 1);
assert.equal(state.videoPausedUntil, clock.now + 10000);
// Once the pause expires with voice keeping up, the normal status returns.
clock.now += 10001;
renderSignal();
assert.equal(element('liveStatus').textContent, 'Live AI connected');
assert.equal(element('liveStatus').className, 'status connected');
// An older relay that never acknowledges must not pause video.
state.ackEvery = 0;
state.unacked.set(30, clock.now);
clock.now += 5000;
renderSignal();
assert.ok(state.videoPausedUntil < clock.now);
console.log('PASS: lagging acknowledgements pause Live video with a visible weak-signal status');
