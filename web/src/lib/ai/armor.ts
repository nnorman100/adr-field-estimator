import { v1 } from '@google-cloud/modelarmor';
import type { ARMOR_CATEGORIES } from './codes';

// Model Armor screening for every model call (docs/plans/S7.md section 3, "Explicit screening fails
// closed"). The Agent Platform integration is fail-open and covers only non-streaming text
// (documents/docs.cloud.google.com/model-armor/model-armor-vertex-integration), so the app calls
// the sanitize API itself and treats anything short of a clean, complete result as a refusal:
// - a timeout or an error;
// - an invocation that is not SUCCESS (PARTIAL: some filters skipped; FAILURE: all skipped, which
//   is also what an image sent to a region without image screening returns);
// - any filter whose executionState is not EXECUTION_SUCCESS;
// - a payload Model Armor cannot screen (empty text, an image that is not JPEG, PNG or BMP or is
//   over 4 MB; documents/docs.cloud.google.com/model-armor/screen-images).
// The text template is in us-central1 and the image template in `us` (V3). Each client talks to its
// template's regional endpoint, modelarmor.<location>.rep.googleapis.com
// (documents/docs.cloud.google.com/model-armor/sanitize-prompts-responses). Streaming sanitize takes
// text only and runs in realtime mode, one result per chunk. Verdicts carry a category, never the
// screened text or Model Armor's findings.

export type ArmorCategory = (typeof ARMOR_CATEGORIES)[number];

export type ArmorVerdict =
  { ok: true; category: 'passed' } | { ok: false; category: Exclude<ArmorCategory, 'passed'>; retryable: boolean };

type EnumValue = string | number | null | undefined;
type FilterState = { executionState?: EnumValue; matchState?: EnumValue } | null | undefined;
export type SanitizeResult = {
  filterMatchState?: EnumValue;
  invocationResult?: EnumValue;
  filterResults?: Record<string, Record<string, unknown> | null | undefined> | null;
};

type Request = Record<string, unknown>;
type Reply = { sanitizationResult?: SanitizeResult | null } | null | undefined;

// The parts of the generated client this file uses (google-gax CancellableStream for the streams).
export type ArmorStreamHandle = {
  write(request: Request): unknown;
  end(): unknown;
  cancel(): unknown;
  on(event: 'data', listener: (reply: Reply) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
};
export type SanitizeClient = {
  sanitizeUserPrompt(request: Request, options?: { timeout?: number }): Promise<readonly [Reply, ...unknown[]]>;
  sanitizeModelResponse(request: Request, options?: { timeout?: number }): Promise<readonly [Reply, ...unknown[]]>;
  streamSanitizeUserPrompt(options?: { timeout?: number }): ArmorStreamHandle;
  streamSanitizeModelResponse(options?: { timeout?: number }): ArmorStreamHandle;
};

export type ArmorTemplates = { text: string; image: string };

export type ArmorStream = { screen(chunk: string): Promise<ArmorVerdict>; close(): void };

export type Armor = {
  screenPrompt(input: { text: string } | { image: Uint8Array }): Promise<ArmorVerdict>;
  screenResponse(input: { text: string }): Promise<ArmorVerdict>;
  openStream(direction: 'prompt' | 'response'): ArmorStream;
};

const PASSED: ArmorVerdict = Object.freeze({ ok: true, category: 'passed' });
const refuse = (category: Exclude<ArmorCategory, 'passed'>): ArmorVerdict => ({
  ok: false,
  category,
  retryable: category.startsWith('unavailable_'),
});

// Enum names, or the proto numbers a client may return (modelarmor/v1/service.proto).
const MATCH = { 1: 'NO_MATCH_FOUND', 2: 'MATCH_FOUND' } as Record<number, string>;
const INVOCATION = { 1: 'SUCCESS', 2: 'PARTIAL', 3: 'FAILURE' } as Record<number, string>;
const EXECUTION = { 1: 'EXECUTION_SUCCESS', 2: 'EXECUTION_SKIPPED' } as Record<number, string>;
const name = (value: EnumValue, numbers: Record<number, string>) =>
  typeof value === 'number' ? numbers[value] : typeof value === 'string' ? value : undefined;

const CATEGORY: Record<string, Exclude<ArmorCategory, 'passed'>> = {
  rai: 'blocked_rai',
  sdp: 'blocked_sdp',
  pi_and_jailbreak: 'blocked_pi_jailbreak',
  malicious_uris: 'blocked_malicious_uri',
  csam: 'blocked_csam',
};
const SINGLE = [
  'raiFilterResult',
  'piAndJailbreakFilterResult',
  'maliciousUriFilterResult',
  'csamFilterFilterResult',
  'virusScanFilterResult',
];
const SDP = ['inspectResult', 'deidentifyResult', 'redactResult'];

// The execution and match states inside one filterResults entry; empty when the shape is unknown.
function states(entry: Record<string, unknown> | null | undefined): FilterState[] {
  if (!entry || typeof entry !== 'object') return [];
  const out: FilterState[] = [];
  for (const key of SINGLE) if (entry[key]) out.push(entry[key] as FilterState);
  const sdp = entry.sdpFilterResult as Record<string, unknown> | undefined;
  if (sdp && typeof sdp === 'object') for (const key of SDP) if (sdp[key]) out.push(sdp[key] as FilterState);
  return out;
}

export function judge(result: SanitizeResult | null | undefined): ArmorVerdict {
  if (!result || typeof result !== 'object') return refuse('unavailable_error');
  const match = name(result.filterMatchState, MATCH);
  if (match !== 'MATCH_FOUND' && match !== 'NO_MATCH_FOUND') return refuse('unavailable_error');
  const filters = Object.entries(result.filterResults ?? {});
  if (match === 'MATCH_FOUND') {
    for (const [key, entry] of filters) {
      if (states(entry).some((s) => name(s?.matchState, MATCH) === 'MATCH_FOUND'))
        return refuse(CATEGORY[key] ?? 'blocked_other');
    }
    return refuse('blocked_other');
  }
  if (name(result.invocationResult, INVOCATION) !== 'SUCCESS') return refuse('unavailable_partial');
  if (filters.length === 0) return refuse('unavailable_partial');
  for (const [, entry] of filters) {
    const found = states(entry);
    if (found.length === 0 || found.some((s) => name(s?.executionState, EXECUTION) !== 'EXECUTION_SUCCESS')) {
      return refuse('unavailable_partial');
    }
  }
  return PASSED;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_MAGIC = [
  [0xff, 0xd8, 0xff], // JPEG
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x42, 0x4d], // BMP
];

function screenableImage(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return false;
  return IMAGE_MAGIC.some((magic) => magic.every((byte, i) => bytes[i] === byte));
}

const screenableText = (text: unknown): text is string => typeof text === 'string' && text.trim().length > 0;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createArmor(options: {
  textClient: SanitizeClient;
  imageClient: SanitizeClient;
  templates: ArmorTemplates;
  timeoutMs: number;
}): Armor {
  const { textClient, imageClient, templates, timeoutMs } = options;

  async function unary(call: () => Promise<readonly [Reply, ...unknown[]]>): Promise<ArmorVerdict> {
    try {
      const answer = await withTimeout(call(), timeoutMs);
      if (answer === 'timeout') return refuse('unavailable_timeout');
      return judge(answer[0]?.sanitizationResult);
    } catch {
      return refuse('unavailable_error');
    }
  }

  function openStream(direction: 'prompt' | 'response'): ArmorStream {
    const field = direction === 'prompt' ? 'userPromptData' : 'modelResponseData';
    let handle: ArmorStreamHandle | undefined;
    let broken = false;
    let first = true;
    const waiting: ((verdict: ArmorVerdict) => void)[] = [];

    const breakAll = () => {
      broken = true;
      for (const resolve of waiting.splice(0)) resolve(refuse('unavailable_error'));
    };
    const close = () => {
      broken = true;
      for (const resolve of waiting.splice(0)) resolve(refuse('unavailable_error'));
      try {
        handle?.end();
        handle?.cancel();
      } catch {
        // already closed
      }
    };

    try {
      handle =
        direction === 'prompt' ? textClient.streamSanitizeUserPrompt() : textClient.streamSanitizeModelResponse();
      handle.on('data', (reply: Reply) => waiting.shift()?.(judge(reply?.sanitizationResult)));
      handle.on('error', breakAll);
      handle.on('end', breakAll);
      handle.on('close', breakAll);
    } catch {
      broken = true;
    }

    return {
      screen(chunk: string): Promise<ArmorVerdict> {
        if (broken || !handle) return Promise.resolve(refuse('unavailable_error'));
        if (!screenableText(chunk)) return Promise.resolve(refuse('unsupported'));
        const request: Request = first
          ? { name: templates.text, [field]: { text: chunk }, streamingMode: 'STREAMING_MODE_REALTIME' }
          : { [field]: { text: chunk } };
        first = false;
        const answer = new Promise<ArmorVerdict>((resolve) => waiting.push(resolve));
        try {
          handle.write(request);
        } catch {
          breakAll();
        }
        return withTimeout(answer, timeoutMs).then((verdict) => {
          if (verdict !== 'timeout') return verdict;
          // Results arrive in order; once one is late the rest cannot be matched to their chunks.
          close();
          return refuse('unavailable_timeout');
        });
      },
      close,
    };
  }

  return {
    screenPrompt(input) {
      if ('image' in input) {
        if (!screenableImage(input.image)) return Promise.resolve(refuse('unsupported'));
        const request = {
          name: templates.image,
          userPromptData: { byteItem: { byteDataType: 'IMAGE', byteData: input.image } },
        };
        return unary(() => imageClient.sanitizeUserPrompt(request, { timeout: timeoutMs }));
      }
      if (!screenableText(input.text)) return Promise.resolve(refuse('unsupported'));
      const request = { name: templates.text, userPromptData: { text: input.text } };
      return unary(() => textClient.sanitizeUserPrompt(request, { timeout: timeoutMs }));
    },
    screenResponse(input) {
      if (!screenableText(input.text)) return Promise.resolve(refuse('unsupported'));
      const request = { name: templates.text, modelResponseData: { text: input.text } };
      return unary(() => textClient.sanitizeModelResponse(request, { timeout: timeoutMs }));
    },
    openStream,
  };
}

const TEMPLATE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/([a-z]+(?:-[a-z]+\d*)?)\/templates\/[A-Za-z0-9_-]{1,63}$/;

// modelarmor.<location>.rep.googleapis.com for a template's full resource name.
export function templateEndpoint(template: string): string {
  const match = TEMPLATE.exec(template);
  if (!match) throw new Error('Model Armor template must be projects/<project>/locations/<location>/templates/<id>.');
  return `modelarmor.${match[1]}.rep.googleapis.com`;
}

// The real clients, one per template endpoint. Credentials come from ADC on Cloud Run.
export function createArmorClients(templates: ArmorTemplates): {
  textClient: SanitizeClient;
  imageClient: SanitizeClient;
} {
  const client = (template: string) =>
    new v1.ModelArmorClient({ apiEndpoint: templateEndpoint(template) }) as unknown as SanitizeClient;
  return { textClient: client(templates.text), imageClient: client(templates.image) };
}
