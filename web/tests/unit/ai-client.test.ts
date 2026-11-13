import { describe, expect, it } from 'vitest';
import { AiModelError } from '@/lib/ai/call';
import { AiConfigError, createGenAiClient, genAiModel, parseAiClientConfig, type GenAiModels } from '@/lib/ai/client';

// The Gen AI SDK on Vertex with ADC (S7-1). Text runs on the `us` multi-region endpoint and Live on
// `us-central1` (V4): documents/docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations
// gives https://aiplatform.us.rep.googleapis.com for `us`, which @google/genai picks for location 'us'.

const CONFIG = parseAiClientConfig({ project: 'dryscope' });

describe('config', () => {
  it('defaults text to us and Live to us-central1', () => {
    expect(CONFIG).toEqual({ project: 'dryscope', locations: { text: 'us', live: 'us-central1' } });
  });

  it('refuses another location, a missing project and a malformed project id', () => {
    expect(() =>
      parseAiClientConfig({ project: 'dryscope', locations: { text: 'global', live: 'us-central1' } }),
    ).toThrow(AiConfigError);
    expect(() => parseAiClientConfig({ project: 'dryscope', locations: { text: 'us', live: 'europe-west1' } })).toThrow(
      AiConfigError,
    );
    expect(() => parseAiClientConfig({ project: '' })).toThrow(AiConfigError);
    expect(() => parseAiClientConfig({ project: 'Bad Project' })).toThrow(AiConfigError);
  });
});

describe('client', () => {
  it('builds a Vertex client per endpoint on the documented hosts', () => {
    const text = createGenAiClient(CONFIG, 'text');
    const live = createGenAiClient(CONFIG, 'live');
    expect(text.vertexai).toBe(true);
    expect(text.baseUrl).toBe('https://aiplatform.us.rep.googleapis.com/');
    expect(live.baseUrl).toBe('https://us-central1-aiplatform.googleapis.com/');
  });
});

describe('model adapter', () => {
  function fakeModels(answer: (params: Record<string, unknown>) => Promise<unknown>): {
    models: GenAiModels;
    calls: Record<string, unknown>[];
  } {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      models: {
        generateContent: async (params) => {
          calls.push(params as unknown as Record<string, unknown>);
          return answer(params as unknown as Record<string, unknown>) as never;
        },
      },
    };
  }

  it('sends the instruction, parts, cap, JSON type and abort signal, and returns text and usage', async () => {
    const { models, calls } = fakeModels(async () => ({
      text: '{"ok":true}',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    }));
    const controller = new AbortController();
    const image = new Uint8Array([1, 2, 3]);
    const reply = await genAiModel(() => models).generate({
      model: 'gemini-3.8-flash',
      endpoint: 'text',
      systemInstruction: 'Read the meter.',
      parts: [{ text: 'facts' }, { bytes: image, mimeType: 'image/jpeg' }],
      maxOutputTokens: 100,
      responseMimeType: 'application/json',
      signal: controller.signal,
    });
    expect(reply).toEqual({ text: '{"ok":true}', usage: { promptTokenCount: 10, candidatesTokenCount: 2 } });
    expect(calls[0]).toEqual({
      model: 'gemini-3.8-flash',
      contents: [
        { role: 'user', parts: [{ text: 'facts' }, { inlineData: { mimeType: 'image/jpeg', data: 'AQID' } }] },
      ],
      config: {
        systemInstruction: 'Read the meter.',
        maxOutputTokens: 100,
        responseMimeType: 'application/json',
        abortSignal: controller.signal,
        candidateCount: 1,
      },
    });
  });

  it('leaves out the instruction and JSON type when the feature has none', async () => {
    const { models, calls } = fakeModels(async () => ({ text: 'hello', usageMetadata: {} }));
    await genAiModel(() => models).generate({
      model: 'gemini-3.5-transcribe',
      endpoint: 'text',
      parts: [{ bytes: new Uint8Array([0]), mimeType: 'audio/mp4' }],
      maxOutputTokens: 10,
      signal: new AbortController().signal,
    });
    const config = calls[0]!.config as Record<string, unknown>;
    expect('systemInstruction' in config).toBe(false);
    expect('responseMimeType' in config).toBe(false);
  });

  it('maps a 429 to rate_limited and anything else to failed, without the message', async () => {
    const limited = Object.assign(new Error('Resource exhausted for jane.doe@example.com'), { status: 429 });
    const { models } = fakeModels(async () => Promise.reject(limited));
    const error = await genAiModel(() => models)
      .generate({
        model: 'gemini-3.8-flash',
        endpoint: 'text',
        parts: [{ text: 'x' }],
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiModelError);
    expect((error as AiModelError).kind).toBe('rate_limited');
    expect((error as AiModelError).message).not.toContain('jane.doe');

    const other = fakeModels(async () => Promise.reject(new Error('boom')));
    const failed = await genAiModel(() => other.models)
      .generate({
        model: 'gemini-3.8-flash',
        endpoint: 'text',
        parts: [{ text: 'x' }],
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      })
      .catch((e: unknown) => e);
    expect((failed as AiModelError).kind).toBe('failed');
  });

  it('treats a reply with no text as an empty string', async () => {
    const { models } = fakeModels(async () => ({ usageMetadata: { promptTokenCount: 1 } }));
    const reply = await genAiModel(() => models).generate({
      model: 'gemini-3.8-flash',
      endpoint: 'text',
      parts: [{ text: 'x' }],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    });
    expect(reply.text).toBe('');
  });
});
