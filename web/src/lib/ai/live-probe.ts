import { v1 } from '@google-cloud/modelarmor';
import { GoogleGenAI, Modality, type LiveConnectConfig, type LiveServerMessage, type Session } from '@google/genai';
import type { AuthClient } from 'google-auth-library';
import { judge, templateEndpoint, type ArmorStreamHandle, type SanitizeResult } from './armor';
import { LIVE_LOCATION } from './client';

// S7-0 calibration probes (docs/plans/S7.md, S7-0 and section 7 A). An owner-run measurement tool,
// never app code and never run in CI: web/scripts/probe-live.ts is the command, and it refuses to
// run on any automated runner. It lives inside the AI boundary because it needs the Gen AI SDK and
// the Model Armor client, and the import guard keeps those here. It deliberately skips call.ts's caller, quota and
// budget steps: it sends fixed synthetic text and generated room tone, never a person's words.
//
// Nothing here returns or prints a session handle, transcript, audio, prompt, token or email. Each
// probe returns a record of numbers, booleans and short fixed codes; the script formats them.

export const LIVE_MODEL = 'gemini-3.8-live';
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';

// ---------- Live sessions, as ports ----------

export type LiveEvent =
  | { kind: 'setup' }
  | { kind: 'resumption'; handle: string | null; resumable: boolean; lastConsumedIndex: number | null }
  | { kind: 'usage'; promptTokens: number; audioPromptTokens: number }
  | { kind: 'audio' }
  | { kind: 'turnComplete' }
  | { kind: 'goAway' }
  | { kind: 'error'; httpStatus: number | null }
  | { kind: 'closed'; code: number; permission: string | null };

export type LiveOptions = {
  voice: string;
  handle?: string;
  transparent?: boolean;
  vocabulary?: string[];
  languageCodes?: string[];
};

export type LiveConn = {
  // Waits for the first event that matches, after `from` (an index into the events seen so far).
  next(match: (event: LiveEvent) => boolean, timeoutMs: number, from?: number): Promise<LiveEvent | null>;
  seen(): readonly LiveEvent[];
  sendText(text: string): void;
  sendAudio(pcm16k: Uint8Array): void;
  contextUpdate(systemInstruction: string): void;
  close(): void;
};

export type LiveDialer = { connect(options: LiveOptions): Promise<LiveConn> };

// A Google permission name an error or close reason names, e.g. aiplatform.endpoints.predict. Only
// that token is kept; the rest of the message is dropped.
export function permissionIn(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const match = /\b([a-z]+\.[a-zA-Z]+\.[a-zA-Z]+)\b/.exec(text);
  return match && /^(aiplatform|iam|modelarmor|resourcemanager|serviceusage)\./.test(match[1]!) ? match[1]! : null;
}

// The HTTP status in a refused WebSocket upgrade ("Unexpected server response: 403"), nothing else.
export function httpStatusIn(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = /\b([45]\d\d)\b/.exec(text);
  return match ? Number(match[1]) : null;
}

export function toEvents(message: LiveServerMessage): LiveEvent[] {
  const out: LiveEvent[] = [];
  if (message.setupComplete) out.push({ kind: 'setup' });
  const update = message.sessionResumptionUpdate;
  if (update) {
    const index = update.lastConsumedClientMessageIndex;
    out.push({
      kind: 'resumption',
      handle: typeof update.newHandle === 'string' && update.newHandle ? update.newHandle : null,
      resumable: update.resumable === true,
      lastConsumedIndex: index === undefined || index === null || !/^\d+$/.test(String(index)) ? null : Number(index),
    });
  }
  const content = message.serverContent;
  if (content?.modelTurn?.parts?.some((part) => part.inlineData)) out.push({ kind: 'audio' });
  if (content?.turnComplete) out.push({ kind: 'turnComplete' });
  if (message.goAway) out.push({ kind: 'goAway' });
  const usage = message.usageMetadata;
  if (usage) {
    const audio = (usage.promptTokensDetails ?? [])
      .filter((detail) => String(detail.modality) === 'AUDIO')
      .reduce((sum, detail) => sum + (detail.tokenCount ?? 0), 0);
    out.push({ kind: 'usage', promptTokens: usage.promptTokenCount ?? 0, audioPromptTokens: audio });
  }
  return out;
}

// Events kept in order, with waiters for the next match.
export function eventBuffer() {
  const events: LiveEvent[] = [];
  const waiters: { from: number; match: (e: LiveEvent) => boolean; resolve: (e: LiveEvent | null) => void }[] = [];
  return {
    events: events as readonly LiveEvent[],
    push(...added: LiveEvent[]) {
      for (const event of added) {
        events.push(event);
        for (const waiter of [...waiters]) {
          if (waiter.match(event) || event.kind === 'closed') {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(waiter.match(event) ? event : null);
          }
        }
      }
    },
    next(match: (e: LiveEvent) => boolean, timeoutMs: number, from = 0): Promise<LiveEvent | null> {
      const found = events.slice(from).find(match);
      if (found) return Promise.resolve(found);
      if (events.some((e) => e.kind === 'closed')) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter = { from, match, resolve: (e: LiveEvent | null) => (clearTimeout(timer), resolve(e)) };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          resolve(null);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

export function liveConfig(options: LiveOptions): LiveConnectConfig {
  const config: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
    outputAudioTranscription: {},
    inputAudioTranscription: {
      ...(options.vocabulary ? { customVocabulary: options.vocabulary } : {}),
      ...(options.languageCodes ? { languageCodes: options.languageCodes } : {}),
    },
  };
  if (options.handle !== undefined || options.transparent) {
    config.sessionResumption = {
      ...(options.handle !== undefined ? { handle: options.handle } : {}),
      ...(options.transparent ? { transparent: true } : {}),
    };
  }
  return config;
}

// The real dialer: Vertex Live on the us-central1 regional endpoint, as the given identity.
export function createLiveDialer(options: { project: string; authClient: AuthClient }): LiveDialer {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: options.project,
    location: LIVE_LOCATION,
    apiVersion: 'v1',
    // The SDK carries its own google-auth-library; it only calls getRequestHeaders on this client.
    googleAuthOptions: { authClient: options.authClient as never, scopes: [CLOUD_PLATFORM] },
  });
  return {
    async connect(liveOptions) {
      const buffer = eventBuffer();
      // The SDK resolves connect only after setupComplete, and never when the socket is refused or
      // setup is rejected, so the wait is bounded here.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), SETUP_MS);
      });
      const pending = ai.live.connect({
        model: LIVE_MODEL,
        config: liveConfig(liveOptions),
        callbacks: {
          onmessage: (message) => buffer.push(...toEvents(message)),
          onerror: (event) => buffer.push({ kind: 'error', httpStatus: httpStatusIn(event?.message) }),
          onclose: (event) =>
            buffer.push({ kind: 'closed', code: Number(event?.code ?? 0), permission: permissionIn(event?.reason) }),
        },
      });
      let session: Session | 'timeout';
      try {
        session = await Promise.race([pending, timeout]);
      } catch (error) {
        session = 'timeout';
        buffer.push({ kind: 'error', httpStatus: httpStatusIn((error as Error | null)?.message) });
      } finally {
        clearTimeout(timer);
      }
      if (session === 'timeout') {
        // A session that completes setup after the wait is closed at once, never left open.
        pending.then(
          (late) => late.close(),
          () => {},
        );
        if (!buffer.events.some((e) => e.kind === 'closed')) buffer.push({ kind: 'closed', code: 0, permission: null });
        return deadConn(buffer);
      }
      const live = session;
      return {
        next: buffer.next,
        seen: () => buffer.events,
        sendText: (text) => live.sendRealtimeInput({ text }),
        sendAudio: (pcm) =>
          live.sendRealtimeInput({
            audio: { data: Buffer.from(pcm).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
          }),
        contextUpdate: (systemInstruction) => live.sendContextUpdate({ systemInstruction }),
        close: () => {
          try {
            live.close();
          } catch {
            // already closed
          }
        },
      };
    },
  };
}

function deadConn(buffer: ReturnType<typeof eventBuffer>): LiveConn {
  const nothing = () => {};
  return {
    next: buffer.next,
    seen: () => buffer.events,
    sendText: nothing,
    sendAudio: nothing,
    contextUpdate: nothing,
    close: nothing,
  };
}

// ---------- Live probes ----------

export type Timing = { setupMs: number; turnMs: number };
const SETUP_MS = 20_000;
const TURN_MS = 30_000;
// Fixed synthetic text: no person, job, address or price.
export const PROBE_TURN = 'Reply with one short word: ready.';
export const PROBE_VOCABULARY = ['dehumidifier', 'air mover', 'moisture meter', 'baseboard', 'subfloor'];
export const PROBE_INSTRUCTION = 'You are a calibration probe. Answer in one short word.';

type Opened = {
  conn: LiveConn;
  setup: boolean;
  closeCode: number | null;
  permission: string | null;
  httpStatus: number | null;
};

async function open(dialer: LiveDialer, options: LiveOptions): Promise<Opened> {
  const conn = await dialer.connect(options);
  const setup = await conn.next((e) => e.kind === 'setup', SETUP_MS);
  if (setup) return { conn, setup: true, closeCode: null, permission: null, httpStatus: null };
  const closed = conn.seen().find((e) => e.kind === 'closed');
  const failed = conn.seen().find((e) => e.kind === 'error' && e.httpStatus !== null);
  conn.close();
  return {
    conn,
    setup: false,
    closeCode: closed?.kind === 'closed' ? closed.code : null,
    permission: closed?.kind === 'closed' ? closed.permission : null,
    httpStatus: failed?.kind === 'error' ? failed.httpStatus : null,
  };
}

// One text turn; true when the turn completes. Audio replies are counted, never kept.
async function turn(conn: LiveConn, text = PROBE_TURN): Promise<boolean> {
  const from = conn.seen().length;
  conn.sendText(text);
  return (await conn.next((e) => e.kind === 'turnComplete', TURN_MS, from)) !== null;
}

async function handleFrom(conn: LiveConn, from = 0): Promise<{ handle: string | null; index: number | null }> {
  const update = await conn.next((e) => e.kind === 'resumption' && e.resumable && e.handle !== null, TURN_MS, from);
  if (update?.kind !== 'resumption') return { handle: null, index: null };
  const indexed = conn.seen().find((e) => e.kind === 'resumption' && e.lastConsumedIndex !== null);
  return { handle: update.handle, index: indexed?.kind === 'resumption' ? indexed.lastConsumedIndex : null };
}

export type ConnectResult = {
  connected: boolean;
  turn_completed: boolean;
  close_code: number | null;
  http_status: number | null;
  denied_permission: string | null;
  setup_ms: number | null;
};

// (a): a plain session as the impersonated account.
export async function probeConnect(dialer: LiveDialer, now: () => number = Date.now): Promise<ConnectResult> {
  const started = now();
  const opened = await open(dialer, { voice: 'Charon' });
  if (!opened.setup) {
    return {
      connected: false,
      turn_completed: false,
      close_code: opened.closeCode,
      http_status: opened.httpStatus,
      denied_permission: opened.permission,
      setup_ms: null,
    };
  }
  const setupMs = now() - started;
  const done = await turn(opened.conn);
  opened.conn.close();
  return {
    connected: true,
    turn_completed: done,
    close_code: null,
    http_status: null,
    denied_permission: null,
    setup_ms: setupMs,
  };
}

export type SdkFieldsOnline = {
  transparent_and_vocabulary_setup: boolean;
  last_consumed_index_seen: boolean;
  context_update_then_turn: boolean;
  language_codes_setup: boolean;
};

export type VoiceResult = {
  handle_received: boolean;
  resume_same_voice: boolean;
  resume_other_voice: boolean;
  other_voice_close_code: number | null;
};

// (b) online and (c): transparent resumption with the trade vocabulary, a context update, then two
// resumes, the second with another voice. Handles stay in memory only.
export async function probeResumeAndVoice(dialer: LiveDialer): Promise<{ b: SdkFieldsOnline; c: VoiceResult }> {
  const b: SdkFieldsOnline = {
    transparent_and_vocabulary_setup: false,
    last_consumed_index_seen: false,
    context_update_then_turn: false,
    language_codes_setup: false,
  };
  const c: VoiceResult = {
    handle_received: false,
    resume_same_voice: false,
    resume_other_voice: false,
    other_voice_close_code: null,
  };
  const first = await open(dialer, { voice: 'Charon', transparent: true, vocabulary: PROBE_VOCABULARY });
  if (first.setup) {
    b.transparent_and_vocabulary_setup = true;
    await turn(first.conn);
    const from = first.conn.seen().length;
    first.conn.contextUpdate(PROBE_INSTRUCTION);
    b.context_update_then_turn = await turn(first.conn);
    const { handle, index } = await handleFrom(first.conn, from);
    b.last_consumed_index_seen = index !== null;
    first.conn.close();
    if (handle) {
      c.handle_received = true;
      const same = await open(dialer, { voice: 'Charon', handle, transparent: true });
      if (same.setup) {
        c.resume_same_voice = await turn(same.conn);
        const next = await handleFrom(same.conn);
        same.conn.close();
        if (next.handle) {
          const other = await open(dialer, { voice: 'Puck', handle: next.handle, transparent: true });
          if (other.setup) {
            c.resume_other_voice = await turn(other.conn);
            other.conn.close();
          } else c.other_voice_close_code = other.closeCode;
        }
      } else same.conn.close();
    }
  }
  const lang = await open(dialer, { voice: 'Charon', languageCodes: ['en-US'] });
  b.language_codes_setup = lang.setup;
  lang.conn.close();
  return { b, c };
}

// 16 kHz mono PCM16 room tone: deterministic low-level noise near -60 dBFS, as an idle phone mic in
// a quiet room sends. Never speech.
export function roomTone(ms: number, seed = 1): Uint8Array {
  const samples = Math.round((16_000 * ms) / 1000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < samples; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    view.setInt16(i * 2, (state % 61) - 30, true);
  }
  return out;
}

export type IdleResult = {
  idle_seconds: number;
  audio_prompt_tokens_before: number | null;
  audio_prompt_tokens_after: number | null;
  audio_tokens_added: number | null;
  expected_if_billed: number;
  idle_billed: boolean | null;
  replies_during_idle: number;
};

const USAGE_MS = 5_000;

// The last usage report since `from`. A turn's usage may arrive after its turnComplete, so this
// waits, briefly, for one; none in that time is unknown.
async function usageSince(conn: LiveConn, from: number) {
  await conn.next((e) => e.kind === 'usage', USAGE_MS, from);
  return conn
    .seen()
    .slice(from)
    .filter((e) => e.kind === 'usage')
    .at(-1) as Extract<LiveEvent, { kind: 'usage' }> | undefined;
}

// (d): proactive audio is always on for gemini-3.8-live. A text turn, then idle room tone streamed
// in real time, then a second text turn: the audio prompt tokens added across the idle stretch
// show whether idle open-mic time is billed (about 25 tokens a second of audio if it is).
export async function probeIdleBilling(
  dialer: LiveDialer,
  options: { idleSeconds: number; sleep: (ms: number) => Promise<void> },
): Promise<IdleResult | { connected: false; close_code: number | null }> {
  const opened = await open(dialer, { voice: 'Charon' });
  if (!opened.setup) return { connected: false, close_code: opened.closeCode };
  const { conn } = opened;
  await turn(conn);
  const before = await usageSince(conn, 0);
  const idleFrom = conn.seen().length;
  const chunkMs = 100;
  for (let sent = 0; sent < options.idleSeconds * 1000; sent += chunkMs) {
    conn.sendAudio(roomTone(chunkMs, sent + 1));
    await options.sleep(chunkMs);
  }
  const replies = conn.seen().slice(idleFrom).filter((e) => e.kind === 'turnComplete').length;
  const afterFrom = conn.seen().length;
  await turn(conn);
  const after = await usageSince(conn, afterFrom);
  conn.close();
  const expected = 25 * options.idleSeconds;
  const added = before && after ? after.audioPromptTokens - before.audioPromptTokens : null;
  return {
    idle_seconds: options.idleSeconds,
    audio_prompt_tokens_before: before?.audioPromptTokens ?? null,
    audio_prompt_tokens_after: after?.audioPromptTokens ?? null,
    audio_tokens_added: added,
    expected_if_billed: expected,
    idle_billed: added === null ? null : added >= expected / 2,
    replies_during_idle: replies,
  };
}

export type HandleAge = { minutes: number; handle_received: boolean; resumed: boolean; close_code: number | null };

// (f), first half: a session that yields a handle, then closes. The handle is returned to the
// caller only to be passed back to probeHandleAge; it is never printed.
export async function takeHandle(dialer: LiveDialer): Promise<string | null> {
  const opened = await open(dialer, { voice: 'Charon', transparent: true });
  if (!opened.setup) return null;
  await turn(opened.conn);
  const { handle } = await handleFrom(opened.conn);
  opened.conn.close();
  return handle;
}

// (f), second half: resume with a handle after it has aged.
export async function probeHandleAge(dialer: LiveDialer, handle: string | null, minutes: number): Promise<HandleAge> {
  if (!handle) return { minutes, handle_received: false, resumed: false, close_code: null };
  const opened = await open(dialer, { voice: 'Charon', handle, transparent: true });
  if (!opened.setup) return { minutes, handle_received: true, resumed: false, close_code: opened.closeCode };
  const resumed = await turn(opened.conn);
  opened.conn.close();
  return { minutes, handle_received: true, resumed, close_code: null };
}

// ---------- Model Armor streaming sanitize (g) ----------

// Fixed synthetic transcript chunks, sized like Live transcription chunks (a few words each).
export const PROBE_CHUNKS = [
  'the hallway carpet',
  'is wet about six feet',
  'from the bathroom door',
  'baseboard reads',
  'twenty two percent',
  'set two air movers',
  'and one dehumidifier',
  'kitchen subfloor is dry',
  'check the closet next',
  'no visible mold',
  'pad is saturated',
  'pull the pad',
  'ceiling below is stained',
  'drywall wicking',
  'about eight inches',
  'cut at two feet',
  'containment not needed',
  'take photos of the meter',
  'living room is unaffected',
  'that is the whole loss',
];

export type ArmorStreamClient = {
  streamSanitizeUserPrompt(): ArmorStreamHandle;
  streamSanitizeModelResponse(): ArmorStreamHandle;
};

export function createArmorStreamClient(options: { template: string; authClient: AuthClient }): ArmorStreamClient {
  return new v1.ModelArmorClient({
    apiEndpoint: templateEndpoint(options.template),
    authClient: options.authClient,
  }) as unknown as ArmorStreamClient;
}

export type SanitizeLatency = {
  direction: 'prompt' | 'response';
  chunks: number;
  answered: number;
  passed: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  error: string | null;
};

// gRPC status codes Model Armor errors carry, as fixed names.
const GRPC: Record<number, string> = {
  3: 'invalid_argument',
  4: 'deadline_exceeded',
  5: 'not_found',
  7: 'permission_denied',
  8: 'resource_exhausted',
  14: 'unavailable',
  16: 'unauthenticated',
};
export const grpcCode = (error: unknown): string => GRPC[Number((error as { code?: unknown } | null)?.code)] ?? 'failed';

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

// One streaming sanitize call in realtime mode: each chunk is written after the previous answer, and
// its latency is write to answer.
export async function probeSanitizeLatency(
  client: ArmorStreamClient,
  template: string,
  direction: 'prompt' | 'response',
  options: { now?: () => number; timeoutMs?: number; chunks?: string[] } = {},
): Promise<SanitizeLatency> {
  const now = options.now ?? (() => performance.now());
  const chunks = options.chunks ?? PROBE_CHUNKS;
  const field = direction === 'prompt' ? 'userPromptData' : 'modelResponseData';
  const latencies: number[] = [];
  let passed = 0;
  let error: string | null = null;
  let handle: ArmorStreamHandle;
  try {
    handle = direction === 'prompt' ? client.streamSanitizeUserPrompt() : client.streamSanitizeModelResponse();
  } catch (e) {
    return { direction, chunks: chunks.length, answered: 0, passed: 0, p50_ms: null, p95_ms: null, max_ms: null, error: grpcCode(e) };
  }
  let pending: ((r: SanitizeResult | null | undefined) => void) | null = null;
  handle.on('data', (reply) => pending?.(reply?.sanitizationResult));
  handle.on('error', (e) => {
    error = error ?? grpcCode(e);
    pending?.(null);
  });
  for (const [i, chunk] of chunks.entries()) {
    if (error) break;
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<SanitizeResult | null | undefined | 'timeout'>((resolve) => {
      pending = resolve;
      timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? 5000);
    });
    handle.write(
      i === 0
        ? { name: template, [field]: { text: chunk }, streamingMode: 'STREAMING_MODE_REALTIME' }
        : { [field]: { text: chunk } },
    );
    const result = await answer;
    clearTimeout(timer);
    pending = null;
    if (result === 'timeout') {
      error = error ?? 'timeout';
      break;
    }
    if (result === null) break;
    latencies.push(now() - started);
    if (judge(result).ok) passed += 1;
  }
  try {
    handle.end();
    handle.cancel();
  } catch {
    // already closed
  }
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    direction,
    chunks: chunks.length,
    answered: latencies.length,
    passed,
    p50_ms: round(percentile(latencies, 50)),
    p95_ms: round(percentile(latencies, 95)),
    max_ms: round(latencies.length ? Math.max(...latencies) : null),
    error,
  };
}
