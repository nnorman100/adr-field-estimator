import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROBE_INSTRUCTION,
  PROBE_VOCABULARY,
  createLiveDialer,
  eventBuffer,
  httpStatusIn,
  liveConfig,
  permissionIn,
  probeConnect,
  probeIdleBilling,
  probeSanitizeLatency,
  roomTone,
  toEvents,
  type ArmorStreamClient,
  type LiveConn,
  type LiveDialer,
  type LiveEvent,
  type LiveOptions,
} from '@/lib/ai/live-probe';
import {
  LIVE_TEST_ACCOUNT,
  ProbeArgsError,
  formatLine,
  parseProbeArgs,
  runProbe,
  type ProbePorts,
} from '../../scripts/probe-live';

// S7-0 calibration probes (docs/plans/S7.md, S7-0). The probe is owner-run against Google Cloud;
// these tests run it against fakes only and hold its guards: dryscope and dryscope-live-test only,
// never automated, and only measurements printed.

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const SECRET_HANDLE = 'HANDLE-SECRET-4f1c';
const SECRET_TEXT = 'owner@example.com said 12 Main Street';
const OK_ARGS = ['--impersonate', LIVE_TEST_ACCOUNT];

describe('arguments and guards', () => {
  it('accepts the owner command', () => {
    expect(parseProbeArgs(OK_ARGS, {})).toEqual({ impersonate: LIVE_TEST_ACCOUNT });
  });

  it('takes no project: any --project is refused, dryscope included', () => {
    for (const project of ['dryscope', 'alert-disaster-field-2026', 'demo-dryscope', 'dryscope-live']) {
      expect(() => parseProbeArgs([...OK_ARGS, '--project', project], {}), project).toThrow(/unknown argument/);
      expect(() => parseProbeArgs(['--project', project, ...OK_ARGS], {}), project).toThrow(/unknown argument/);
    }
  });

  it('refuses any account but the relay test account, including the live relay account', () => {
    expect(() => parseProbeArgs([], {})).toThrow(ProbeArgsError);
    for (const account of [
      'dryscope-live-live@dryscope.iam.gserviceaccount.com',
      'dryscope-api-test@dryscope.iam.gserviceaccount.com',
      'dryscope-live-test@other.iam.gserviceaccount.com',
    ]) {
      expect(() => parseProbeArgs(['--impersonate', account], {}), account).toThrow(/--impersonate must be/);
    }
  });

  it('refuses to run on any automated runner', () => {
    for (const name of ['CI', 'GITHUB_ACTIONS', 'K_SERVICE', 'CLOUD_RUN_JOB']) {
      expect(() => parseProbeArgs(OK_ARGS, { [name]: 'true' }), name).toThrow(/owner-run only/);
    }
  });

  it('refuses any other argument, including timing overrides', () => {
    for (const extra of [['--location', 'us'], ['--resume-minutes', '1'], ['--idle-seconds', '20'], ['--impersonate']]) {
      expect(() => parseProbeArgs([...OK_ARGS, ...extra], {}), extra.join(' ')).toThrow(/unknown argument/);
    }
    expect(() => parseProbeArgs(['--impersonate'], {})).toThrow(/--impersonate must be/);
  });
});

describe('output is measurements only', () => {
  it('prints numbers, yes/no, n/a and short codes', () => {
    expect(formatLine('(a)', 'live_connected', true)).toBe('(a) live_connected: yes');
    expect(formatLine('(d)', 'audio_tokens_added', 1500)).toBe('(d) audio_tokens_added: 1500');
    expect(formatLine('(f)', 'after_2_min_close_code', null)).toBe('(f) after_2_min_close_code: n/a');
    expect(formatLine('(a)', 'live_denied_permission', 'aiplatform.endpoints.predict')).toBe(
      '(a) live_denied_permission: aiplatform.endpoints.predict',
    );
  });

  it('refuses an email, a handle-like token, free text and non-finite numbers', () => {
    for (const value of [
      LIVE_TEST_ACCOUNT,
      'owner@example.com',
      'CiQ2ZjM4ZTQ5Ny1hYmNkLTRlZjAtODkxMi0zNDU2Nzg5MGFiY2QSBgoEdGVzdA',
      'ya29.a0AfB_byC',
      'Permission denied on resource projects/dryscope',
      'the hallway carpet is wet',
    ]) {
      expect(() => formatLine('(a)', 'value', value), value).toThrow(/refused/);
    }
    expect(() => formatLine('(a)', 'value', Number.NaN)).toThrow(/refused/);
    expect(() => formatLine('(z)', 'value', 1)).toThrow(/refused/);
  });
});

// ---------- a local stand-in for the Live WebSocket endpoint ----------

// Just enough of RFC 6455 for the SDK's ws client: the upgrade, masked text frames in, unmasked
// text frames out. Each client frame is parsed as JSON and kept; `reply` answers it.
async function liveSocketServer(reply: (frame: Record<string, unknown>, send: (m: unknown) => void) => void) {
  const frames: Record<string, unknown>[] = [];
  const sockets: Duplex[] = [];
  const server = createServer();
  server.on('upgrade', (req, socket: Duplex) => {
    sockets.push(socket);
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (message: unknown) => {
      const data = Buffer.from(JSON.stringify(message));
      const head =
        data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
      socket.write(Buffer.concat([head, data]));
    };
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const opcode = buffered[0]! & 0x0f;
        let length = buffered[1]! & 0x7f;
        let at = 2;
        if (length === 126) [length, at] = [buffered.readUInt16BE(2), 4];
        else if (length === 127) [length, at] = [Number(buffered.readBigUInt64BE(2)), 10];
        if (buffered.length < at + 4 + length) return;
        const mask = buffered.subarray(at, at + 4);
        const payload = Buffer.from(buffered.subarray(at + 4, at + 4 + length)).map((b, i) => b ^ mask[i % 4]!);
        buffered = buffered.subarray(at + 4 + length);
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode === 1) {
          const frame = JSON.parse(Buffer.from(payload).toString('utf8')) as Record<string, unknown>;
          frames.push(frame);
          reply(frame, send);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    frames,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('(b) offline: the installed SDK sends and receives every field S7 needs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('the real dialer sends transparent resumption, custom vocabulary and a context update, and reads the consumed index', async () => {
    const live = await liveSocketServer((frame, send) => {
      if (frame.setup) send({ setupComplete: {} });
      if (frame.realtimeInput) {
        send({ sessionResumptionUpdate: { newHandle: SECRET_HANDLE, resumable: true, lastConsumedClientMessageIndex: '3' } });
        send({ serverContent: { turnComplete: true } });
      }
    });
    vi.stubEnv('GOOGLE_VERTEX_BASE_URL', live.url);
    try {
      const authClient = { getRequestHeaders: async () => new Headers({ authorization: 'Bearer fake' }) };
      const dialer = createLiveDialer({ project: 'dryscope', authClient: authClient as never });
      const conn = await dialer.connect({ voice: 'Charon', transparent: true, vocabulary: PROBE_VOCABULARY });
      expect(await conn.next((e) => e.kind === 'setup', 5_000)).toEqual({ kind: 'setup' });
      conn.contextUpdate(PROBE_INSTRUCTION);
      conn.sendText('ready');
      expect(await conn.next((e) => e.kind === 'turnComplete', 5_000)).toEqual({ kind: 'turnComplete' });
      conn.close();

      const setup = live.frames.find((f) => f.setup)?.setup as Record<string, unknown>;
      expect(setup.sessionResumption).toEqual({ transparent: true });
      expect(setup.inputAudioTranscription).toEqual({ customVocabulary: PROBE_VOCABULARY });
      expect(JSON.stringify(live.frames.find((f) => f.contextUpdate))).toContain(PROBE_INSTRUCTION);
      expect(conn.seen()).toContainEqual({ kind: 'resumption', handle: SECRET_HANDLE, resumable: true, lastConsumedIndex: 3 });
    } finally {
      await live.stop();
    }
  });
});

describe('Live message handling', () => {
  it('keeps only event kinds, counts and the consumed index from server messages', () => {
    const events = toEvents({
      setupComplete: {},
      sessionResumptionUpdate: { newHandle: 'HANDLE', resumable: true, lastConsumedClientMessageIndex: '7' },
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm' } }] },
        outputTranscription: { text: 'my secret words' },
        turnComplete: true,
      },
      usageMetadata: {
        promptTokenCount: 900,
        promptTokensDetails: [
          { modality: 'AUDIO' as never, tokenCount: 600 },
          { modality: 'TEXT' as never, tokenCount: 300 },
        ],
      },
    } as never);
    expect(events).toEqual([
      { kind: 'setup' },
      { kind: 'resumption', handle: 'HANDLE', resumable: true, lastConsumedIndex: 7 },
      { kind: 'audio' },
      { kind: 'turnComplete' },
      { kind: 'usage', promptTokens: 900, audioPromptTokens: 600 },
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('extracts only a permission name or an HTTP status from errors', () => {
    expect(permissionIn("Permission 'aiplatform.endpoints.predict' denied for owner@example.com")).toBe(
      'aiplatform.endpoints.predict',
    );
    expect(permissionIn('closed by owner@example.com')).toBeNull();
    expect(httpStatusIn('Unexpected server response: 403')).toBe(403);
    expect(httpStatusIn('socket hang up')).toBeNull();
  });

  it('builds the setup the plan names: audio, voice, transcription with vocabulary, transparent resumption', () => {
    expect(
      liveConfig({ voice: 'Puck', handle: 'h', transparent: true, vocabulary: ['subfloor'] }),
    ).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
      outputAudioTranscription: {},
      inputAudioTranscription: { customVocabulary: ['subfloor'] },
      sessionResumption: { handle: 'h', transparent: true },
    });
    expect(liveConfig({ voice: 'Charon' }).sessionResumption).toBeUndefined();
  });

  it('makes quiet, deterministic room tone at 16 kHz', () => {
    const tone = roomTone(100);
    expect(tone.length).toBe(3200);
    const view = new DataView(tone.buffer);
    for (let i = 0; i < 1600; i++) expect(Math.abs(view.getInt16(i * 2, true))).toBeLessThanOrEqual(30);
    expect(roomTone(100)).toEqual(tone);
  });
});

// ---------- a fake Live service ----------

type FakeLive = {
  refuse?: { code: number; permission: string | null };
  handleLifeMs?: number; // a handle older than this is refused
  refuseVoiceChange?: boolean;
  idleBilled?: boolean;
  usageAfterTurn?: boolean; // the usage report comes after turnComplete, on a later tick
};

// Time is Date.now(), which the whole-probe tests fake with vitest's timers.
function fakeDialer(behaviour: FakeLive = {}): { dialer: LiveDialer; opened: LiveOptions[] } {
  const issued = new Map<string, { at: number; voice: string }>();
  const opened: LiveOptions[] = [];
  let count = 0;
  const dialer: LiveDialer = {
    async connect(options) {
      opened.push(options);
      const buffer = eventBuffer();
      const close = (code: number, permission: string | null = null) =>
        queueMicrotask(() => buffer.push({ kind: 'closed', code, permission }));
      const conn: LiveConn = {
        next: buffer.next,
        seen: () => buffer.events,
        sendText() {
          const audio = idleMs * (behaviour.idleBilled ? 25 / 1000 : 0) + 40;
          const handle = `${SECRET_HANDLE}-${++count}`;
          issued.set(handle, { at: Date.now(), voice: options.voice });
          const usage: LiveEvent = { kind: 'usage', promptTokens: audio + 100, audioPromptTokens: audio };
          queueMicrotask(() =>
            buffer.push(
              { kind: 'audio' },
              {
                kind: 'resumption',
                handle,
                resumable: true,
                lastConsumedIndex: options.transparent ? count : null,
              },
              ...(behaviour.usageAfterTurn ? [] : [usage]),
              { kind: 'turnComplete' },
            ),
          );
          if (behaviour.usageAfterTurn) setTimeout(() => buffer.push(usage), 10);
        },
        sendAudio(pcm) {
          idleMs += (pcm.length / 2 / 16_000) * 1000;
        },
        contextUpdate() {},
        close() {},
      };
      let idleMs = 0;
      if (behaviour.refuse) close(behaviour.refuse.code, behaviour.refuse.permission);
      else if (options.handle !== undefined) {
        const known = issued.get(options.handle);
        if (!known || Date.now() - known.at > (behaviour.handleLifeMs ?? Infinity)) close(1008);
        else if (behaviour.refuseVoiceChange && known.voice !== options.voice) close(1007);
        else queueMicrotask(() => buffer.push({ kind: 'setup' }));
      } else queueMicrotask(() => buffer.push({ kind: 'setup' }));
      return conn;
    },
  };
  return { dialer, opened };
}

function fakeArmor(behaviour: { refuse?: number } = {}): ArmorStreamClient {
  const stream = () => {
    const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
    return {
      on(event: string, listener: (arg?: unknown) => void) {
        (listeners[event] ??= []).push(listener);
        return this;
      },
      write() {
        queueMicrotask(() => {
          if (behaviour.refuse) for (const l of listeners.error ?? []) l({ code: behaviour.refuse, details: SECRET_TEXT });
          else
            for (const l of listeners.data ?? [])
              l({
                sanitizationResult: {
                  filterMatchState: 'NO_MATCH_FOUND',
                  invocationResult: 'SUCCESS',
                  filterResults: { rai: { raiFilterResult: { executionState: 'EXECUTION_SUCCESS' } } },
                },
              });
        });
      },
      end() {},
      cancel() {},
    };
  };
  return { streamSanitizeUserPrompt: stream, streamSanitizeModelResponse: stream } as unknown as ArmorStreamClient;
}

function ports(overrides: Partial<ProbePorts> = {}): ProbePorts {
  return {
    dialer: fakeDialer().dialer,
    impersonation: 'ok',
    liveTestArmor: fakeArmor({ refuse: 7 }),
    ownerArmor: fakeArmor(),
    testPermissions: async () => ({
      'aiplatform.endpoints.predict': true,
      'aiplatform.customJobs.create': false,
      'aiplatform.endpoints.get': false,
    }),
    readOwner: async (url) =>
      url.includes('floorSetting')
        ? { status: 404, body: { error: SECRET_TEXT } }
        : { status: 200, body: { name: SECRET_TEXT, templateMetadata: { logTemplateOperations: true } } },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...overrides,
  };
}

// Runs the probe on fake timers: the 2, 10 and 30 minute waits pass instantly, in order.
async function run(p: ProbePorts): Promise<string[]> {
  vi.useFakeTimers({ now: 1_000_000 });
  const lines: string[] = [];
  const done = runProbe(p, (line) => lines.push(line));
  await vi.runAllTimersAsync();
  await done;
  return lines;
}

afterEach(() => {
  vi.useRealTimers();
});

const value = (lines: string[], key: string) => lines.find((l) => l.split(' ')[1] === `${key}:`)?.split(': ')[1];

describe('the whole probe against a fake Live service', () => {
  it('answers (a) to (h) and prints no handle, email, transcript or error text', async () => {
    const lines = await run(ports());
    const out = lines.join('\n');
    for (const q of ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)', '(h)']) expect(out).toContain(q);
    expect(out).not.toMatch(/HANDLE|SECRET|@|Main Street|said/);
    expect(value(lines, 'live_connected')).toBe('yes');
    expect(value(lines, 'holds_aiplatform.endpoints.predict')).toBe('yes');
    expect(value(lines, 'holds_aiplatform.customJobs.create')).toBe('no');
    expect(value(lines, 'live_last_consumed_index_seen')).toBe('yes');
    expect(value(lines, 'live_context_update_then_turn')).toBe('yes');
    expect(value(lines, 'resume_other_voice')).toBe('yes');
    expect(value(lines, 'idle_billed')).toBe('no');
    expect(value(lines, 'idle_seconds')).toBe('60');
    expect(value(lines, 'expected_if_billed')).toBe('1500');
    expect(lines.filter((l) => l.startsWith('(f)') && l.includes('_resumed:'))).toEqual([
      '(f) after_2_min_resumed: yes',
      '(f) after_10_min_resumed: yes',
      '(f) after_30_min_resumed: yes',
    ]);
    expect(value(lines, 'after_2_min_resumed')).toBe('yes');
    expect(value(lines, 'after_30_min_resumed')).toBe('yes');
    expect(Number(value(lines, 'after_30_min_waited_minutes'))).toBeGreaterThanOrEqual(30);
    // Model Armor refused the test account, so the latency was measured with the owner's sign-in.
    expect(value(lines, 'as_live_test_prompt_error')).toBe('permission_denied');
    expect(value(lines, 'as_owner_prompt_answered')).toBe('20');
    expect(value(lines, 'as_owner_response_passed')).toBe('20');
    expect(value(lines, 'spike_template_log_sanitize_operations')).toBe('no');
    expect(value(lines, 'spike_template_log_template_operations')).toBe('yes');
    expect(value(lines, 'floor_setting_read')).toBe('not_found');
  });

  it('records expired handles, a refused voice change and idle billing', async () => {
    const { dialer } = fakeDialer({
      handleLifeMs: 15 * 60_000,
      refuseVoiceChange: true,
      idleBilled: true,
    });
    const lines = await run(ports({ dialer }));
    expect(value(lines, 'after_2_min_resumed')).toBe('yes');
    expect(value(lines, 'after_10_min_resumed')).toBe('yes');
    expect(value(lines, 'after_30_min_resumed')).toBe('no');
    expect(value(lines, 'after_30_min_close_code')).toBe('1008');
    expect(value(lines, 'resume_same_voice')).toBe('yes');
    expect(value(lines, 'resume_other_voice')).toBe('no');
    expect(value(lines, 'other_voice_close_code')).toBe('1007');
    expect(value(lines, 'idle_billed')).toBe('yes');
  });

  it('when Live refuses the account, says so with the permission and still runs (g) and (h)', async () => {
    const { dialer, opened } = fakeDialer({
      refuse: { code: 1008, permission: 'aiplatform.endpoints.bidiGenerateContent' },
    });
    const lines = await run(ports({ dialer }));
    expect(value(lines, 'live_connected')).toBe('no');
    expect(value(lines, 'live_close_code')).toBe('1008');
    expect(value(lines, 'live_denied_permission')).toBe('aiplatform.endpoints.bidiGenerateContent');
    expect(opened).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('(f)') || l.startsWith('(c)'))).toBe(false);
    expect(value(lines, 'as_owner_prompt_answered')).toBe('20');
    expect(value(lines, 'spike_template_exists')).toBe('yes');
  });

  it('when impersonation fails, opens no Live session', async () => {
    const lines = await run(ports({ dialer: null, impersonation: 'permission_denied' }));
    expect(value(lines, 'impersonation')).toBe('permission_denied');
    expect(lines.some((l) => l.startsWith('(a) live_'))).toBe(false);
  });
});

describe('single probes', () => {
  it('times setup and reports a refused upgrade by HTTP status', async () => {
    const buffer = eventBuffer();
    const dialer: LiveDialer = {
      async connect() {
        buffer.push({ kind: 'error', httpStatus: 403 }, { kind: 'closed', code: 1006, permission: null });
        return { next: buffer.next, seen: () => buffer.events, sendText() {}, sendAudio() {}, contextUpdate() {}, close() {} };
      },
    };
    expect(await probeConnect(dialer)).toEqual({
      connected: false,
      turn_completed: false,
      close_code: 1006,
      http_status: 403,
      denied_permission: null,
      setup_ms: null,
    });
  });

  it('streams idle room tone in real time for the requested seconds', async () => {
    const clock = { t: 0 };
    const { dialer } = fakeDialer({ idleBilled: true });
    const result = await probeIdleBilling(dialer, { idleSeconds: 20, sleep: async (ms) => void (clock.t += ms) });
    expect(clock.t).toBe(20_000);
    expect(result).toMatchObject({ idle_seconds: 20, expected_if_billed: 500, audio_tokens_added: 500, idle_billed: true });
  });

  it('waits for usage that arrives after the turn completes, before and after the idle stretch', async () => {
    const { dialer } = fakeDialer({ idleBilled: true, usageAfterTurn: true });
    const result = await probeIdleBilling(dialer, { idleSeconds: 20, sleep: async () => {} });
    expect(result).toMatchObject({
      audio_prompt_tokens_before: 40,
      audio_prompt_tokens_after: 540,
      audio_tokens_added: 500,
      idle_billed: true,
    });
  });

  it('measures each chunk from write to answer and stops at a timeout', async () => {
    let t = 0;
    const result = await probeSanitizeLatency(fakeArmor(), 'projects/dryscope/locations/us-central1/templates/x', 'prompt', {
      now: () => (t += 50),
      chunks: ['one', 'two', 'three'],
    });
    expect(result).toMatchObject({ chunks: 3, answered: 3, passed: 3, p50_ms: 50, p95_ms: 50, error: null });
    const silent = {
      streamSanitizeUserPrompt: () => ({ on() {}, write() {}, end() {}, cancel() {} }),
    } as unknown as ArmorStreamClient;
    const timed = await probeSanitizeLatency(silent, 'projects/dryscope/locations/us-central1/templates/x', 'prompt', {
      timeoutMs: 5,
      chunks: ['one', 'two'],
    });
    expect(timed).toMatchObject({ answered: 0, error: 'timeout' });
  });

  it('a waiter resolves with null when the session closes first', async () => {
    const buffer = eventBuffer();
    const waiting = buffer.next((e: LiveEvent) => e.kind === 'setup', 10_000);
    buffer.push({ kind: 'closed', code: 1011, permission: null });
    expect(await waiting).toBeNull();
  });
});

// ---------- the owner command refuses before it reaches Google ----------

describe('the probe:live command', () => {
  // Credentials point nowhere, so a run that got past the guards would fail on them instead.
  const command = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/probe-live.ts', ...args], {
      cwd: WEB,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/adc.json',
        ...env,
      },
    });

  it('refuses on an automated runner and for another account, printing only its refusal', () => {
    for (const name of ['CI', 'GITHUB_ACTIONS', 'K_SERVICE', 'CLOUD_RUN_JOB']) {
      const run = command(OK_ARGS, { [name]: 'true' });
      expect(run.status, name).toBe(1);
      expect(run.stderr.trim(), name).toBe(`refusing to run: ${name} is set (the probe is owner-run only, never automated)`);
      expect(run.stdout, name).toBe('');
    }
    const other = command(['--impersonate', 'dryscope-live-live@dryscope.iam.gserviceaccount.com'], {});
    expect(other.status).toBe(1);
    expect(other.stderr.trim()).toBe(`refusing to run: --impersonate must be ${LIVE_TEST_ACCOUNT}`);
    expect(other.stdout).toBe('');
  }, 120_000);
});
