import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  eventBuffer,
  httpStatusIn,
  liveConfig,
  permissionIn,
  probeConnect,
  probeIdleBilling,
  probeSanitizeLatency,
  roomTone,
  sdkLiveFields,
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
// never automated, only measurements printed, and no app code or workflow reaches it.

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const OK_ARGS = ['--impersonate', LIVE_TEST_ACCOUNT];

describe('arguments and guards', () => {
  it('accepts the owner command with the plan defaults', () => {
    expect(parseProbeArgs(OK_ARGS, {})).toEqual({
      project: 'dryscope',
      impersonate: LIVE_TEST_ACCOUNT,
      resumeMinutes: [2, 10, 30],
      idleSeconds: 60,
    });
    expect(parseProbeArgs([...OK_ARGS, '--project', 'dryscope', '--resume-minutes', '1', '--idle-seconds', '20'], {}))
      .toMatchObject({ resumeMinutes: [1], idleSeconds: 20 });
  });

  it('refuses any project but dryscope', () => {
    for (const project of ['alert-disaster-field-2026', 'demo-dryscope', 'dryscope-live', 'DRYSCOPE']) {
      expect(() => parseProbeArgs([...OK_ARGS, '--project', project], {}), project).toThrow(/--project must be dryscope/);
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

  it('refuses unknown arguments and out-of-range waits', () => {
    expect(() => parseProbeArgs([...OK_ARGS, '--location', 'us'], {})).toThrow(/unknown argument/);
    expect(() => parseProbeArgs([...OK_ARGS, '--resume-minutes', '0,10'], {})).toThrow(/resume-minutes/);
    expect(() => parseProbeArgs([...OK_ARGS, '--resume-minutes', '2,x'], {})).toThrow(/resume-minutes/);
    expect(() => parseProbeArgs([...OK_ARGS, '--idle-seconds', '5'], {})).toThrow(/idle-seconds/);
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

describe('(b) offline: the installed SDK carries every field S7 needs', () => {
  const dts = readFileSync(join(WEB, 'node_modules/@google/genai/dist/genai.d.ts'), 'utf8');

  it('finds transparent resumption, the consumed index, custom vocabulary and context updates', () => {
    expect(sdkLiveFields(dts)).toEqual({
      session_resumption_transparent: true,
      last_consumed_client_message_index: true,
      custom_vocabulary: true,
      context_update: true,
    });
  });

  it('reports a field the types lack as missing', () => {
    const without = dts.replace(/\n(\s+)transparent\?:/g, '\n$1removed?:');
    expect(sdkLiveFields(without).session_resumption_transparent).toBe(false);
    expect(sdkLiveFields('').custom_vocabulary).toBe(false);
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
      liveConfig({ voice: 'Puck', handle: 'h', transparent: true, vocabulary: ['subfloor'], languageCodes: ['en-US'] }),
    ).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
      outputAudioTranscription: {},
      inputAudioTranscription: { customVocabulary: ['subfloor'], languageCodes: ['en-US'] },
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

const SECRET_HANDLE = 'HANDLE-SECRET-4f1c';
const SECRET_TEXT = 'owner@example.com said 12 Main Street';

type FakeLive = {
  refuse?: { code: number; permission: string | null };
  handleLifeMs?: number; // a handle older than this is refused
  refuseVoiceChange?: boolean;
  idleBilled?: boolean;
  dropLanguageCodes?: boolean;
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
          queueMicrotask(() =>
            buffer.push(
              { kind: 'audio' },
              {
                kind: 'resumption',
                handle,
                resumable: true,
                lastConsumedIndex: options.transparent ? count : null,
              },
              { kind: 'usage', promptTokens: audio + 100, audioPromptTokens: audio },
              { kind: 'turnComplete' },
            ),
          );
        },
        sendAudio(pcm) {
          idleMs += (pcm.length / 2 / 16_000) * 1000;
        },
        contextUpdate() {},
        close() {},
      };
      let idleMs = 0;
      if (behaviour.refuse) close(behaviour.refuse.code, behaviour.refuse.permission);
      else if (behaviour.dropLanguageCodes && options.languageCodes) close(1007);
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
    sdkTypes: () => readFileSync(join(WEB, 'node_modules/@google/genai/dist/genai.d.ts'), 'utf8'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...overrides,
  };
}

// Runs the probe on fake timers: the 2, 10 and 30 minute waits pass instantly, in order.
async function run(p: ProbePorts, args = OK_ARGS): Promise<string[]> {
  vi.useFakeTimers({ now: 1_000_000 });
  const lines: string[] = [];
  const done = runProbe(parseProbeArgs(args, {}), p, (line) => lines.push(line));
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
    expect(value(lines, 'sdk_types_session_resumption_transparent')).toBe('yes');
    expect(value(lines, 'live_last_consumed_index_seen')).toBe('yes');
    expect(value(lines, 'live_context_update_then_turn')).toBe('yes');
    expect(value(lines, 'resume_other_voice')).toBe('yes');
    expect(value(lines, 'idle_billed')).toBe('no');
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

  it('records expired handles, a refused voice change, idle billing and refused language codes', async () => {
    const { dialer } = fakeDialer({
      handleLifeMs: 15 * 60_000,
      refuseVoiceChange: true,
      idleBilled: true,
      dropLanguageCodes: true,
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
    expect(value(lines, 'live_language_codes_setup')).toBe('no');
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

// ---------- reach: only the owner's script uses the probe ----------

function files(dir: string, test: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!['node_modules', '.next', '.git', 'test-results', 'playwright-report'].includes(entry.name)) {
        files(join(dir, entry.name), test, out);
      }
    } else if (test.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

describe('reach', () => {
  it('no app code imports the probe module; only web/scripts/probe-live.ts does', () => {
    const importers = files(WEB, /\.(?:[cm]?[jt]s|tsx)$/)
      .filter((file) => /['"`][^'"`]*\/live-probe['"`]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(WEB, file).split(sep).join('/'));
    expect(importers.sort()).toEqual(['scripts/probe-live.ts', 'tests/unit/live-probe.test.ts']);
  });

  it('no workflow runs the probe', () => {
    const workflows = files(join(REPO, '.github'), /\.ya?ml$/);
    expect(workflows.length).toBeGreaterThan(0);
    for (const file of workflows) expect(readFileSync(file, 'utf8'), file).not.toMatch(/probe-live|probe:live/);
  });
});
