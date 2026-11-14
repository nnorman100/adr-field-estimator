import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ArmorVerdict } from '@/lib/ai/armor';
import {
  AiModelError,
  createAiBoundary,
  type AiBudgetPort,
  type AiCallerContext,
  type AiModelPort,
  type AiModelRequest,
  type AiQuotaPort,
  type BoundaryDeps,
} from '@/lib/ai/call';
import type { AiLogLine } from '@/lib/ai/telemetry';
import { AI_REGISTRY, definePrompt, type AiRegistry } from '@/lib/ai/registry';
import type { AiSpanAttributes } from '@/lib/ai/span';

// The AI boundary's call order (S7-1, docs/plans/S7.md section 3): caller context, capability and
// flag, per-user quota, budget reservation, Model Armor on the input, the model with a deadline,
// Zod, Model Armor on the output, server rules, settlement, one log line and span. Fakes stand in
// for the model, Model Armor, the quota and the budget (S7-4 brings the real ones).

const COMPANY = '00000000-0000-4000-8000-00000000000a';
const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const JOB = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-11-13T12:00:00Z');

const PASS: ArmorVerdict = { ok: true, category: 'passed' };
const BLOCK: ArmorVerdict = { ok: false, category: 'blocked_pi_jailbreak', retryable: false };
const DOWN: ArmorVerdict = { ok: false, category: 'unavailable_timeout', retryable: true };

const PROMPT = definePrompt('You draft a findings summary from the saved inspection facts.');

const REGISTRY: AiRegistry = {
  ...AI_REGISTRY,
  summary_draft: { ...AI_REGISTRY.summary_draft, prompt: PROMPT, deadlineMs: 200 },
  meter_reading: { ...AI_REGISTRY.meter_reading, prompt: PROMPT, deadlineMs: 200 },
};

const SUMMARY = z.object({ summary: z.string().min(1).max(6000), suggestions: z.array(z.string().min(1)).max(30) });

function context(overrides: Partial<AiCallerContext> = {}): AiCallerContext {
  return {
    companyId: COMPANY,
    actorId: ACTOR,
    jobId: JOB,
    capabilities: ['audit', 'scope', 'ocr', 'jobs_read', 'live'],
    flags: { ai_summary: true, ai_meter_reading: true, ai_voice_notes: true },
    ...overrides,
  };
}

const reply = (text: string, usage = { promptTokenCount: 1000, candidatesTokenCount: 200 }) => ({ text, usage });

function harness(
  options: {
    model?: (request: AiModelRequest) => Promise<{ text: string; usage: Record<string, unknown> }>;
    prompt?: ArmorVerdict | (() => Promise<ArmorVerdict>);
    response?: ArmorVerdict | (() => Promise<ArmorVerdict>);
    quota?: boolean;
    budget?: Awaited<ReturnType<AiBudgetPort['reserve']>>;
    registry?: AiRegistry;
  } = {},
) {
  const events: string[] = [];
  const modelCalls: AiModelRequest[] = [];
  const logs: AiLogLine[] = [];
  const spans: AiSpanAttributes[] = [];
  const screened: unknown[] = [];
  const settled: { id: string; microUsd: number }[] = [];
  const held: string[] = [];
  const reserved: number[] = [];

  const verdict = (v: ArmorVerdict | (() => Promise<ArmorVerdict>) | undefined) =>
    typeof v === 'function' ? v() : Promise.resolve(v ?? PASS);

  const model: AiModelPort = {
    async generate(request) {
      events.push('model');
      modelCalls.push(request);
      return options.model
        ? options.model(request)
        : reply('{"summary":"Water in the kitchen.","suggestions":["Remove baseboards."]}');
    },
  };
  const quota: AiQuotaPort = {
    async take() {
      events.push('quota');
      return options.quota ?? true;
    },
  };
  const budget: AiBudgetPort = {
    async reserve(request) {
      events.push('reserve');
      reserved.push(request.microUsd);
      return options.budget ?? { ok: true, reservationId: 'res-1' };
    },
    async settle(id, microUsd) {
      events.push('settle');
      settled.push({ id, microUsd });
    },
    async hold(id) {
      events.push('hold');
      held.push(id);
    },
  };
  const deps: BoundaryDeps = {
    registry: options.registry ?? REGISTRY,
    model,
    armor: {
      async screenPrompt(input) {
        events.push('screen-in');
        screened.push(input);
        return verdict(options.prompt);
      },
      async screenResponse(input) {
        events.push('screen-out');
        screened.push(input);
        return verdict(options.response);
      },
    },
    quota,
    budget,
    log: (line) => {
      events.push('log');
      logs.push(line);
    },
    span: async (attributes, fn) => {
      const result = await fn({ setAttributes: (more) => spans.push({ ...attributes, ...more }) });
      spans.push(attributes);
      return result;
    },
    now: () => NOW,
    sleep: async () => undefined,
    newCallId: () => 'call-1',
  };
  return { boundary: createAiBoundary(deps), events, modelCalls, logs, spans, screened, settled, held, reserved };
}

const summaryRequest = {
  feature: 'summary_draft' as const,
  facts: 'Kitchen: category 2 water, 3 rooms wet.',
  schema: SUMMARY,
};

describe('the happy path', () => {
  it('runs the eleven steps in order and returns the validated output', async () => {
    const h = harness();
    const outcome = await h.boundary.call(context(), summaryRequest);
    expect(outcome).toEqual({
      ok: true,
      callId: 'call-1',
      output: { summary: 'Water in the kitchen.', suggestions: ['Remove baseboards.'] },
      model: 'gemini-3.8-flash',
      promptVersion: PROMPT.version,
    });
    expect(h.events).toEqual(['quota', 'reserve', 'screen-in', 'model', 'screen-out', 'settle', 'log']);
  });

  it('calls the model on the text endpoint with the prompt first, the output cap and JSON output', async () => {
    const h = harness();
    await h.boundary.call(context(), summaryRequest);
    const request = h.modelCalls[0]!;
    expect(request).toMatchObject({
      model: 'gemini-3.8-flash',
      endpoint: 'text',
      systemInstruction: PROMPT.text,
      parts: [{ text: summaryRequest.facts }],
      maxOutputTokens: 16_384,
      responseMimeType: 'application/json',
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('reserves input bytes / 3 plus the output cap, and settles from usage metadata', async () => {
    const h = harness();
    await h.boundary.call(context(), summaryRequest);
    const bytes = Buffer.byteLength(PROMPT.text) + Buffer.byteLength(summaryRequest.facts);
    // $0.75/M input and $3.75/M output through 2026 (pricing.ts), rounded up.
    expect(h.reserved).toEqual([Math.ceil((Math.ceil(bytes / 3) * 750_000 + 16_384 * 3_750_000) / 1_000_000)]);
    expect(h.settled).toEqual([{ id: 'res-1', microUsd: 750 + 750 }]);
    expect(h.held).toEqual([]);
  });

  it('logs one allowlisted line with tokens, latency, outcome and verdict', async () => {
    const h = harness();
    await h.boundary.call(context(), summaryRequest);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toEqual({
      feature: 'summary_draft',
      model: 'gemini-3.8-flash',
      promptVersion: PROMPT.version,
      inputTokens: 1000,
      outputTokens: 200,
      latencyMs: expect.any(Number),
      outcome: 'ok',
      verdict: 'passed',
    });
  });
});

describe('refusals', () => {
  it('refuses a missing or malformed caller context before anything else', async () => {
    for (const bad of [context({ companyId: '' }), context({ actorId: 'not-a-uuid' }), context({ jobId: 'x' })]) {
      const h = harness();
      expect(await h.boundary.call(bad, summaryRequest)).toMatchObject({
        ok: false,
        refusal: { code: 'invalid_context' },
      });
      expect(h.events).toEqual(['log']);
    }
  });

  it('refuses without the capability, and with the feature switch off', async () => {
    const noCap = harness();
    expect(await noCap.boundary.call(context({ capabilities: ['scope'] }), summaryRequest)).toMatchObject({
      ok: false,
      refusal: { code: 'not_allowed', retryable: false },
    });
    expect(noCap.events).toEqual(['log']);
    const off = harness();
    expect(await off.boundary.call(context({ flags: {} }), summaryRequest)).toMatchObject({
      ok: false,
      refusal: { code: 'feature_off', retryable: false },
    });
    const notTrue = harness();
    expect(
      await notTrue.boundary.call(context({ flags: { ai_summary: 'yes' as never } }), summaryRequest),
    ).toMatchObject({
      refusal: { code: 'feature_off' },
    });
  });

  it('refuses a feature whose prompt is not written yet, and Live (the relay path)', async () => {
    const h = harness({ registry: AI_REGISTRY });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({ refusal: { code: 'not_ready' } });
    const live = harness();
    expect(
      await live.boundary.call(context({ flags: { live_voice: true } }), {
        feature: 'live',
        facts: 'x',
        schema: z.string(),
      }),
    ).toMatchObject({ refusal: { code: 'not_ready' } });
    expect(h.events).toEqual(['log']);
  });

  it('refuses over the per-user quota before reserving money', async () => {
    const h = harness({ quota: false });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'quota', retryable: false },
    });
    expect(h.events).toEqual(['quota', 'log']);
  });

  it('refuses when the budget refuses, before Model Armor or the model', async () => {
    const h = harness({ budget: { ok: false, reason: 'daily' } });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({ refusal: { code: 'budget' } });
    expect(h.events).toEqual(['quota', 'reserve', 'log']);
    const held = harness({ budget: { ok: false, reason: 'held' } });
    expect(await held.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'budget', retryable: true },
    });
  });

  it('carries the ledger’s Retry-After, and its quota count, into the refusal (S7-4)', async () => {
    const daily = harness({ budget: { ok: false, reason: 'daily', retryAfterSeconds: 43_200 } });
    expect(await daily.boundary.call(context(), summaryRequest)).toEqual({
      ok: false,
      refusal: { code: 'budget', retryable: false, retryAfterSeconds: 43_200, message: expect.stringContaining('keep working without AI') },
    });
    // The ledger counts the person's calls in the same transaction as the money: its quota refusal
    // is a quota refusal, not a budget one, and nothing reaches Model Armor or the model.
    const quota = harness({ budget: { ok: false, reason: 'quota', retryAfterSeconds: 600 } });
    expect(await quota.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'quota', retryable: false, retryAfterSeconds: 600 },
    });
    expect(quota.events).toEqual(['quota', 'reserve', 'log']);
    // The quota port's own refusal waits for the next UTC day: NOW is 12:00 UTC.
    const early = harness({ quota: false });
    expect(await early.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'quota', retryAfterSeconds: 12 * 60 * 60 },
    });
  });

  it('refuses a blocked input and settles the unused reservation at zero', async () => {
    const h = harness({ prompt: BLOCK });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'input_blocked', retryable: false },
    });
    expect(h.events).toEqual(['quota', 'reserve', 'screen-in', 'settle', 'log']);
    expect(h.settled).toEqual([{ id: 'res-1', microUsd: 0 }]);
    expect(h.logs[0]).toMatchObject({ outcome: 'input_blocked', verdict: 'blocked_pi_jailbreak' });
  });

  it('refuses with "AI not available, try again" when Model Armor times out on the input', async () => {
    const h = harness({ prompt: DOWN });
    const outcome = await h.boundary.call(context(), summaryRequest);
    expect(outcome).toMatchObject({ ok: false, refusal: { code: 'screen_unavailable', retryable: true } });
    if (!outcome.ok) expect(outcome.refusal.message).toMatch(/AI not available, try again/);
    expect(h.modelCalls).toEqual([]);
  });

  it('refuses when Model Armor itself throws, never treating it as an allow', async () => {
    const h = harness({ prompt: () => Promise.reject(new Error('boom')) });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({ refusal: { code: 'screen_unavailable' } });
    expect(h.modelCalls).toEqual([]);
  });

  it('refuses unsupported input shapes for the feature', async () => {
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const h = harness();
    // Text features take text only; image features need an image; transcription takes audio only.
    expect(
      await h.boundary.call(context(), { ...summaryRequest, image: { bytes: image, mimeType: 'image/jpeg' } }),
    ).toMatchObject({
      refusal: { code: 'unsupported_input' },
    });
    expect(
      await h.boundary.call(context(), { feature: 'meter_reading', facts: 'meter', schema: z.unknown() }),
    ).toMatchObject({
      refusal: { code: 'unsupported_input' },
    });
    expect(
      await h.boundary.call(context(), {
        feature: 'voice_note',
        facts: 'transcribe this',
        audio: { bytes: new Uint8Array([1]), mimeType: 'audio/mp4' },
        schema: z.string(),
      }),
    ).toMatchObject({ refusal: { code: 'unsupported_input' } });
    expect(h.modelCalls).toEqual([]);
  });

  it('refuses output that fails Zod, after settling what the model used', async () => {
    const h = harness({ model: async () => reply('{"summary":""}') });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'invalid_output', retryable: true },
    });
    expect(h.settled).toEqual([{ id: 'res-1', microUsd: 1500 }]);
    const notJson = harness({ model: async () => reply('Sure! Here is the summary.') });
    expect(await notJson.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'invalid_output' },
    });
    expect(notJson.events).not.toContain('screen-out');
  });

  it('refuses a blocked output, and an output check that times out', async () => {
    const blocked = harness({ response: { ok: false, category: 'blocked_rai', retryable: false } });
    expect(await blocked.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'output_blocked' },
    });
    expect(blocked.settled).toHaveLength(1);
    const down = harness({ response: DOWN });
    expect(await down.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'screen_unavailable', retryable: true },
    });
  });

  it('refuses when the model misses its deadline, and keeps the hold', async () => {
    const h = harness({
      model: (request) =>
        new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'model_timeout', retryable: true },
    });
    expect(h.held).toEqual(['res-1']);
    expect(h.settled).toEqual([]);
    // A model that ignores the abort signal is cut off by the deadline all the same.
    const deaf = harness({ model: () => new Promise(() => undefined) });
    expect(await deaf.boundary.call(context(), summaryRequest)).toMatchObject({ refusal: { code: 'model_timeout' } });
  });

  it('retries a 429 with backoff inside the deadline, then gives up as busy', async () => {
    let tries = 0;
    // Room for the 250 ms, 500 ms ... backoff; the fake sleep returns at once.
    const roomy: AiRegistry = { ...REGISTRY, summary_draft: { ...REGISTRY.summary_draft, deadlineMs: 10_000 } };
    const recovers = harness({
      registry: roomy,
      model: async () => {
        tries += 1;
        if (tries < 3) throw new AiModelError('rate_limited');
        return reply('{"summary":"Dry.","suggestions":[]}');
      },
    });
    expect(await recovers.boundary.call(context(), summaryRequest)).toMatchObject({ ok: true });
    expect(tries).toBe(3);

    let busyTries = 0;
    const busy = harness({
      registry: roomy,
      model: async () => {
        busyTries += 1;
        throw new AiModelError('rate_limited');
      },
    });
    expect(await busy.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'model_busy', retryable: true },
    });
    expect(busyTries).toBe(5);
    // A 429 is refused before work, so the reservation settles at zero.
    expect(busy.settled).toEqual([{ id: 'res-1', microUsd: 0 }]);
  });

  it('keeps the hold when the model fails in an unknown way', async () => {
    const h = harness({ model: async () => Promise.reject(new Error('socket hang up')) });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({
      refusal: { code: 'model_failed', retryable: true },
    });
    expect(h.held).toEqual(['res-1']);
  });
});

describe('server rules', () => {
  it('strips a price sentence from every output string', async () => {
    const h = harness({
      model: async () =>
        reply(
          '{"summary":"Category 2 water in the kitchen. Drying will cost $1,200.","suggestions":["Remove baseboards."]}',
        ),
    });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({
      ok: true,
      output: { summary: 'Category 2 water in the kitchen.', suggestions: ['Remove baseboards.'] },
    });
  });

  it('re-validates after the rules, so an output that was only a price is refused', async () => {
    const h = harness({ model: async () => reply('{"summary":"The total is $900.","suggestions":[]}') });
    expect(await h.boundary.call(context(), summaryRequest)).toMatchObject({ refusal: { code: 'invalid_output' } });
  });

  it('applies the feature rules after the price rule', async () => {
    const h = harness();
    const outcome = await h.boundary.call(context(), {
      ...summaryRequest,
      rules: (output) => ({ ...output, suggestions: [] }),
    });
    expect(outcome).toMatchObject({ ok: true, output: { suggestions: [] } });
  });
});

describe('image and audio features', () => {
  it('screens a meter photo with the image template, then sends the same bytes', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const h = harness({ model: async () => reply('{"value":"23.4"}') });
    const outcome = await h.boundary.call(context(), {
      feature: 'meter_reading',
      image: { bytes, mimeType: 'image/jpeg' },
      schema: z.object({ value: z.string() }),
    });
    expect(outcome).toMatchObject({ ok: true, output: { value: '23.4' } });
    expect(h.screened[0]).toEqual({ image: bytes });
    expect(h.modelCalls[0]!.parts).toEqual([{ bytes, mimeType: 'image/jpeg' }]);
  });

  it('refuses a meter photo when the image screen fails', async () => {
    const h = harness({ prompt: { ok: false, category: 'unavailable_partial', retryable: true } });
    const outcome = await h.boundary.call(context(), {
      feature: 'meter_reading',
      image: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' },
      schema: z.unknown(),
    });
    expect(outcome).toMatchObject({ refusal: { code: 'screen_unavailable' } });
    expect(h.modelCalls).toEqual([]);
  });

  it('transcribes audio with no instructions and screens the transcript', async () => {
    const audio = { bytes: new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), mimeType: 'audio/mp4' };
    const h = harness({ model: async () => reply('Three air movers in the den.') });
    const outcome = await h.boundary.call(context(), { feature: 'voice_note', audio, schema: z.string().min(1) });
    expect(outcome).toMatchObject({ ok: true, output: 'Three air movers in the den.', promptVersion: null });
    expect(h.modelCalls[0]).toMatchObject({ model: 'gemini-3.5-transcribe', parts: [audio], maxOutputTokens: 8192 });
    expect(h.modelCalls[0]!.systemInstruction).toBeUndefined();
    expect(h.modelCalls[0]!.responseMimeType).toBeUndefined();
    expect(h.events).toEqual(['quota', 'reserve', 'model', 'screen-out', 'settle', 'log']);
  });
});

describe('no personal data in logs or spans', () => {
  const EMAIL = 'jane.doe@example.com';
  const ADDRESS = '1234 Elm Street, Springfield';
  const COORDS = '37.774929, -122.419416';
  const PII = [EMAIL, ADDRESS, COORDS, 'jane.doe', 'example.com', 'Elm Street', '37.774929', '122.419416'];
  const facts = `Customer ${EMAIL} at ${ADDRESS} (${COORDS}). Kitchen is wet.`;

  function scan(h: ReturnType<typeof harness>) {
    const seen = JSON.stringify({ logs: h.logs, spans: h.spans });
    for (const needle of PII) expect(seen, needle).not.toContain(needle);
    expect(h.logs).toHaveLength(1);
    expect(h.spans.length).toBeGreaterThan(0);
  }

  it('keeps them out on success, with the model echoing the input', async () => {
    const h = harness({
      model: async (request) =>
        reply(JSON.stringify({ summary: (request.parts[0] as { text: string }).text, suggestions: [] })),
    });
    expect(await h.boundary.call(context(), { ...summaryRequest, facts })).toMatchObject({ ok: true });
    scan(h);
  });

  it('keeps them out when the output fails Zod, is blocked, or the model throws with the text', async () => {
    const zodFail = harness({ model: async () => reply(JSON.stringify({ summary: facts, suggestions: 'x' })) });
    await zodFail.boundary.call(context(), { ...summaryRequest, facts });
    scan(zodFail);
    const blocked = harness({ prompt: BLOCK });
    await blocked.boundary.call(context(), { ...summaryRequest, facts });
    scan(blocked);
    const thrown = harness({ model: async () => Promise.reject(new Error(`failed on ${facts}`)) });
    await thrown.boundary.call(context(), { ...summaryRequest, facts });
    scan(thrown);
  });

  it('writes only the allowlisted fields to stdout through the default log sink', async () => {
    const { aiLog } = await import('@/lib/ai/telemetry');
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      aiLog({
        feature: 'summary_draft',
        model: 'gemini-3.8-flash',
        promptVersion: PROMPT.version,
        inputTokens: 1,
        outputTokens: 2,
        latencyMs: 3,
        outcome: 'ok',
        verdict: 'passed',
        // Anything else a caller slips in is dropped.
        ...({ text: facts, email: EMAIL } as object),
      } as AiLogLine);
      aiLog({ feature: EMAIL, model: ADDRESS, promptVersion: COORDS } as unknown as AiLogLine);
    } finally {
      process.stdout.write = write;
    }
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(Object.keys(first).sort()).toEqual(
      [
        'component',
        'feature',
        'inputTokens',
        'latencyMs',
        'message',
        'model',
        'outcome',
        'outputTokens',
        'promptVersion',
        'severity',
        'verdict',
      ].sort(),
    );
    for (const needle of PII) expect(lines.join('\n'), needle).not.toContain(needle);
  });
});
