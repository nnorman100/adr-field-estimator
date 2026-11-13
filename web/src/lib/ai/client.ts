import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse, type Part } from '@google/genai';
import { z } from 'zod';
import { AiModelError, type AiModelPort, type AiModelRequest } from './call';

// The Gen AI SDK on Vertex (Agent Platform) with Application Default Credentials: the runtime
// account on Cloud Run, nothing else (documents/docs.cloud.google.com/gemini-enterprise-agent-
// platform/models/sdks/overview). Locations (V4, docs/plans/S7.md section 3):
// - text: the `us` multi-region endpoint, https://aiplatform.us.rep.googleapis.com, which the SDK
//   picks for location "us" (documents/docs.cloud.google.com/gemini-enterprise-agent-platform/
//   resources/locations, "Multi-region endpoints");
// - live: the `us-central1` regional endpoint.
// The settings that feed this (AI_TEXT_LOCATION, LIVE_LOCATION and the project) are S7-2's, read
// through web/src/lib/config.ts; until then the caller passes them in.

export const TEXT_LOCATION = 'us';
export const LIVE_LOCATION = 'us-central1';

export class AiConfigError extends Error {
  constructor() {
    super('AI client settings are invalid.');
    this.name = 'AiConfigError';
  }
}

// A Google Cloud project id: 6-30 lowercase letters, digits and hyphens, starting with a letter.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const configSchema = z.object({
  project: z.string().regex(PROJECT_ID),
  locations: z
    .object({ text: z.literal(TEXT_LOCATION), live: z.literal(LIVE_LOCATION) })
    .default({ text: TEXT_LOCATION, live: LIVE_LOCATION }),
});
export type AiClientConfig = z.infer<typeof configSchema>;

export function parseAiClientConfig(input: unknown): AiClientConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new AiConfigError();
  return parsed.data;
}

export type GenAiModels = { generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> };
export type GenAiClient = { vertexai: boolean; baseUrl: string; models: GenAiModels };

export function createGenAiClient(config: AiClientConfig, endpoint: 'text' | 'live'): GenAiClient {
  const location = endpoint === 'text' ? config.locations.text : config.locations.live;
  const ai = new GoogleGenAI({ vertexai: true, project: config.project, location, apiVersion: 'v1' });
  // The host the SDK resolved, so a test can hold it to the documented endpoint.
  const resolved = (ai as unknown as { apiClient?: { getBaseUrl?: () => string } }).apiClient?.getBaseUrl?.();
  return { vertexai: ai.vertexai, baseUrl: resolved ?? '', models: ai.models };
}

function toPart(part: AiModelRequest['parts'][number]): Part {
  if ('text' in part) return { text: part.text };
  return { inlineData: { mimeType: part.mimeType, data: Buffer.from(part.bytes).toString('base64') } };
}

// The model port call.ts uses, over the SDK's generateContent. Errors become AiModelError with a
// fixed message: the SDK's own message can quote the request.
export function genAiModel(modelsFor: (endpoint: 'text' | 'live') => GenAiModels): AiModelPort {
  return {
    async generate(request) {
      const config: NonNullable<GenerateContentParameters['config']> = {
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: request.signal,
        candidateCount: 1,
      };
      if (request.systemInstruction !== undefined) config.systemInstruction = request.systemInstruction;
      if (request.responseMimeType !== undefined) config.responseMimeType = request.responseMimeType;
      let response: GenerateContentResponse;
      try {
        response = await modelsFor(request.endpoint).generateContent({
          model: request.model,
          contents: [{ role: 'user', parts: request.parts.map(toPart) }],
          config,
        });
      } catch (error) {
        const status = (error as { status?: unknown } | null)?.status;
        throw new AiModelError(status === 429 ? 'rate_limited' : 'failed');
      }
      return { text: typeof response.text === 'string' ? response.text : '', usage: response.usageMetadata ?? {} };
    },
  };
}

// The production model: one lazily built client per endpoint.
export function vertexModel(config: AiClientConfig): AiModelPort {
  const clients = new Map<'text' | 'live', GenAiClient>();
  return genAiModel((endpoint) => {
    let client = clients.get(endpoint);
    if (!client) {
      client = createGenAiClient(config, endpoint);
      clients.set(endpoint, client);
    }
    return client.models;
  });
}
