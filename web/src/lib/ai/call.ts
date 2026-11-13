import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Armor, ArmorVerdict } from './armor';
import type { AiRefusalCode } from './codes';
import { aiLog, aiTelemetry, type AiLogLine, type AiVerdict } from './telemetry';
import {
  costMicroUsd,
  reserveMicroUsd,
  tokenTotals,
  usageFromMetadata,
  type AiModel,
  type AiUsage,
  type UsageMetadata,
} from './pricing';
import { AI_REGISTRY, isAiFeature, type AiFeature, type AiFeatureEntry, type AiRegistry } from './registry';
import { stripPricesDeep } from './rules';
import { withAiSpan, type AiSpanRunner } from './span';

// The AI boundary: every REST model call in the app goes through call(), in the order of
// docs/plans/S7.md section 3:
//   1. caller context (company, actor, job) from the verified sign-in;
//   2. capability and feature flag;
//   3. per-user quota;
//   4. budget reservation;
//   5. Model Armor screen of the input;
//   6. model call with a deadline;
//   7. Zod validation;
//   8. Model Armor screen of the output;
//   9. server rules (price sentences stripped, then the feature's own rules), and Zod again;
//  10. settlement;
//  11. one allowlisted log line and span.
// Any failure is a refusal with a fixed code and message; nothing is allowed by default. Live is the
// relay's (S7-11 to S7-13) and is refused here. The quota and the budget are ports until S7-4
// brings budget.ts; tests use fakes for them, for the model and for Model Armor.

// ---- Ports --------------------------------------------------------------------------------------

export type AiModelPart = { text: string } | { bytes: Uint8Array; mimeType: string };

export type AiModelRequest = {
  model: AiModel;
  endpoint: 'text' | 'live';
  systemInstruction?: string;
  parts: AiModelPart[];
  maxOutputTokens: number;
  responseMimeType?: 'application/json';
  signal: AbortSignal;
};

export type AiModelReply = { text: string; usage: UsageMetadata };

export type AiModelPort = { generate(request: AiModelRequest): Promise<AiModelReply> };

// What a model failure was, without its message (which can quote the request).
export class AiModelError extends Error {
  constructor(readonly kind: 'rate_limited' | 'failed') {
    super(`AI model call failed: ${kind}`);
    this.name = 'AiModelError';
  }
}

export type AiQuotaPort = {
  // Counts one call against the person's daily quota for the feature (UTC day); false when used up.
  take(request: {
    companyId: string;
    actorId: string;
    feature: AiFeature;
    limit: number;
    day: string;
  }): Promise<boolean>;
};

export type AiReservation = { ok: true; reservationId: string } | { ok: false; reason: 'daily' | 'monthly' | 'held' };

export type AiBudgetPort = {
  reserve(request: {
    companyId: string;
    actorId: string;
    feature: AiFeature;
    callId: string;
    model: AiModel;
    microUsd: number;
    at: Date;
  }): Promise<AiReservation>;
  // The call's real cost (zero when no model work happened).
  settle(reservationId: string, microUsd: number): Promise<void>;
  // The outcome is unknown, so the whole reservation stays held until the sweeper settles it.
  hold(reservationId: string): Promise<void>;
};

export type BoundaryDeps = {
  model: AiModelPort;
  armor: Pick<Armor, 'screenPrompt' | 'screenResponse'>;
  quota: AiQuotaPort;
  budget: AiBudgetPort;
  registry?: AiRegistry;
  log?: (line: AiLogLine) => void;
  span?: AiSpanRunner;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newCallId?: () => string;
};

// ---- Requests and outcomes ----------------------------------------------------------------------

// From the verified sign-in (web/src/lib/auth Identity), never from the request body.
export type AiCallerContext = {
  companyId: string;
  actorId: string;
  jobId?: string;
  capabilities: readonly string[];
  flags: Readonly<Record<string, boolean>>;
};

export type AiRequest<T> = {
  feature: AiFeature;
  // The job's facts as text: no customer name, address or coordinates (each feature's step builds them).
  facts?: string;
  image?: { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png' };
  audio?: { bytes: Uint8Array; mimeType: string };
  schema: z.ZodType<T>;
  // The feature's own server rules, after the price rule (pre-1978 advice, exact quotes).
  rules?: (output: T) => T;
};

export type AiRefusal = { code: AiRefusalCode; retryable: boolean; message: string };

export type AiOutcome<T> =
  | { ok: true; callId: string; output: T; model: AiModel; promptVersion: string | null }
  | { ok: false; refusal: AiRefusal };

const TRY_AGAIN = 'AI not available, try again. Your field work is saved; you can keep working without AI.';
const KEEP_WORKING = 'Your field work is saved; you can keep working without AI.';

const REFUSALS: Readonly<Record<AiRefusalCode, { retryable: boolean; message: string }>> = {
  invalid_context: { retryable: false, message: 'This AI request could not be checked.' },
  not_allowed: { retryable: false, message: 'Your role cannot use this AI feature.' },
  feature_off: { retryable: false, message: `This AI feature is not switched on for your company. ${KEEP_WORKING}` },
  not_ready: { retryable: false, message: `This AI feature is not available yet. ${KEEP_WORKING}` },
  quota: { retryable: false, message: `You have used this AI feature as often as allowed today. ${KEEP_WORKING}` },
  budget: { retryable: false, message: `Your company's AI allowance does not cover this request now. ${KEEP_WORKING}` },
  unsupported_input: { retryable: false, message: `This AI feature cannot read that input. ${KEEP_WORKING}` },
  input_blocked: { retryable: false, message: `The safety check stopped this AI request. ${KEEP_WORKING}` },
  screen_unavailable: { retryable: true, message: TRY_AGAIN },
  model_timeout: { retryable: true, message: TRY_AGAIN },
  model_busy: { retryable: true, message: TRY_AGAIN },
  model_failed: { retryable: true, message: TRY_AGAIN },
  invalid_output: { retryable: true, message: TRY_AGAIN },
  output_blocked: { retryable: false, message: `The safety check stopped the AI answer. ${KEEP_WORKING}` },
};

const contextSchema = z.object({
  companyId: z.uuid(),
  actorId: z.uuid(),
  jobId: z.uuid().optional(),
  capabilities: z.array(z.string()),
  flags: z.record(z.string(), z.unknown()),
});

class Refused extends Error {
  constructor(
    readonly code: AiRefusalCode,
    readonly verdict: AiVerdict = 'not_screened',
    readonly retryable?: boolean,
  ) {
    super(code);
  }
}

const BACKOFF_MS = 250;
const MAX_ATTEMPTS = 5;

// ---- The boundary -------------------------------------------------------------------------------

export function createAiBoundary(deps: BoundaryDeps) {
  const registry = deps.registry ?? AI_REGISTRY;
  const log = deps.log ?? aiLog;
  const span = deps.span ?? withAiSpan;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newCallId = deps.newCallId ?? randomUUID;

  async function screen(work: () => Promise<ArmorVerdict>, blocked: AiRefusalCode): Promise<AiVerdict> {
    let verdict: ArmorVerdict;
    try {
      verdict = await work();
    } catch {
      throw new Refused('screen_unavailable', 'unavailable_error');
    }
    if (verdict.ok) return verdict.category;
    if (verdict.category === 'unsupported') throw new Refused('unsupported_input', verdict.category);
    throw new Refused(verdict.retryable ? 'screen_unavailable' : blocked, verdict.category);
  }

  // The parts the model gets, after checking the input fits the feature's screen.
  function inputParts(
    entry: AiFeatureEntry,
    request: Pick<AiRequest<unknown>, 'facts' | 'image' | 'audio'>,
  ): AiModelPart[] {
    const facts = typeof request.facts === 'string' ? request.facts : undefined;
    switch (entry.inputScreen) {
      case 'text':
        if (request.image || request.audio || !facts?.trim()) throw new Refused('unsupported_input');
        return [{ text: facts }];
      case 'image':
        if (request.audio || !request.image || !(request.image.bytes instanceof Uint8Array))
          throw new Refused('unsupported_input');
        return facts?.trim() ? [{ text: facts }, { ...request.image }] : [{ ...request.image }];
      case 'audio_unscreened':
        if (facts !== undefined || request.image || !request.audio || !(request.audio.bytes instanceof Uint8Array)) {
          throw new Refused('unsupported_input');
        }
        return [{ ...request.audio }];
    }
  }

  async function screenInput(entry: AiFeatureEntry, parts: AiModelPart[]): Promise<AiVerdict> {
    if (entry.inputScreen === 'audio_unscreened') return 'not_screened';
    let verdict: AiVerdict = 'passed';
    // Model Armor takes text or one image per request, never both (screen-images), so each part goes alone.
    for (const part of parts) {
      verdict = await screen(
        () => deps.armor.screenPrompt('text' in part ? { text: part.text } : { image: part.bytes }),
        'input_blocked',
      );
    }
    return verdict;
  }

  async function callModel(request: Omit<AiModelRequest, 'signal'>, deadlineMs: number): Promise<AiModelReply> {
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Refused('model_timeout'));
      }, deadlineMs);
    });
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await Promise.race([deps.model.generate({ ...request, signal: controller.signal }), deadline]);
        } catch (error) {
          if (error instanceof Refused) throw error;
          if (controller.signal.aborted) throw new Refused('model_timeout');
          if (!(error instanceof AiModelError) || error.kind !== 'rate_limited') throw new Refused('model_failed');
          const wait = BACKOFF_MS * 2 ** attempt;
          if (attempt + 1 >= MAX_ATTEMPTS || Date.now() - started + wait >= deadlineMs) throw new Refused('model_busy');
          await Promise.race([sleep(wait), deadline]);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function parse<T>(entry: AiFeatureEntry, schema: z.ZodType<T>, text: string): T {
    let raw: unknown = text;
    if (entry.output === 'json') {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Refused('invalid_output');
      }
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Refused('invalid_output');
    return parsed.data;
  }

  async function call<T>(context: AiCallerContext, request: AiRequest<T>): Promise<AiOutcome<T>> {
    const started = Date.now();
    const callId = newCallId();
    const entry = isAiFeature(request?.feature) ? registry[request.feature] : undefined;
    const line: Partial<AiLogLine> = {
      feature: entry?.feature,
      model: entry?.model,
      promptVersion: entry?.prompt?.version ?? null,
      verdict: 'not_screened',
    };
    let usage: AiUsage = { input: {}, output: {} };

    return span(aiTelemetry(line), async (active) => {
      let reservation: string | undefined;
      let modelRan = false;
      let cost: number | undefined;
      // 10. Settlement: the real cost once the model answered; zero when no model work happened or
      // Google refused it (429); otherwise (timeout, failure) the outcome is unknown and the whole
      // reservation stays held until the sweeper settles it.
      const settle = async (refused?: AiRefusalCode) => {
        if (!reservation) return;
        if (cost !== undefined) await deps.budget.settle(reservation, cost);
        else if (!modelRan || refused === 'model_busy') await deps.budget.settle(reservation, 0);
        else await deps.budget.hold(reservation);
      };

      const finish = (outcome: AiOutcome<T>): AiOutcome<T> => {
        Object.assign(line, tokenTotals(usage), {
          latencyMs: Date.now() - started,
          outcome: outcome.ok ? 'ok' : outcome.refusal.code,
        });
        const fields = aiTelemetry(line);
        active.setAttributes(fields);
        log(line as AiLogLine);
        return outcome;
      };

      try {
        // 1. Caller context.
        if (!entry || !contextSchema.safeParse(context).success) throw new Refused('invalid_context');
        // 2. Capability and feature switch (exactly true; anything else is off).
        if (!context.capabilities.includes(entry.capability)) throw new Refused('not_allowed');
        if (context.flags[entry.flag] !== true) throw new Refused('feature_off');
        if (entry.kind !== 'rest' || entry.outputTokenCap === null || (entry.usesPrompt && !entry.prompt))
          throw new Refused('not_ready');
        const parts = inputParts(entry, request);
        const at = now();
        // 3. Per-user quota.
        const day = at.toISOString().slice(0, 10);
        if (
          !(await deps.quota.take({
            companyId: context.companyId,
            actorId: context.actorId,
            feature: entry.feature,
            limit: entry.dailyQuotaPerUser,
            day,
          }))
        ) {
          throw new Refused('quota');
        }
        // 4. Budget reservation: input bytes / 3 plus the output cap.
        const instruction = entry.usesPrompt ? entry.prompt!.text : undefined;
        const inputBytes =
          (instruction ? Buffer.byteLength(instruction) : 0) +
          parts.reduce((sum, part) => sum + ('text' in part ? Buffer.byteLength(part.text) : part.bytes.byteLength), 0);
        const microUsd = reserveMicroUsd(entry.model, { inputBytes, outputTokenCap: entry.outputTokenCap }, at);
        const held = await deps.budget.reserve({
          companyId: context.companyId,
          actorId: context.actorId,
          feature: entry.feature,
          callId,
          model: entry.model,
          microUsd,
          at,
        });
        if (!held.ok) throw new Refused('budget', 'not_screened', held.reason === 'held');
        reservation = held.reservationId;
        // 5. Model Armor on the input.
        line.verdict = await screenInput(entry, parts);
        // 6. The model, with a deadline.
        modelRan = true;
        const reply = await callModel(
          {
            model: entry.model,
            endpoint: entry.endpoint,
            ...(instruction ? { systemInstruction: instruction } : {}),
            parts,
            maxOutputTokens: entry.outputTokenCap,
            ...(entry.output === 'json' ? { responseMimeType: 'application/json' as const } : {}),
          },
          entry.deadlineMs,
        );
        usage = usageFromMetadata(reply.usage);
        cost = costMicroUsd(entry.model, usage, now());
        // 7. Zod.
        const parsed = parse(entry, request.schema, reply.text);
        // 8. Model Armor on the output.
        line.verdict = await screen(() => deps.armor.screenResponse({ text: reply.text }), 'output_blocked');
        // 9. Server rules, then Zod again on what is left.
        let ruled = stripPricesDeep(parsed);
        if (request.rules) ruled = request.rules(ruled);
        const checked = request.schema.safeParse(ruled);
        if (!checked.success) throw new Refused('invalid_output');
        // 10 and 11.
        await settle();
        return finish({
          ok: true,
          callId,
          output: checked.data,
          model: entry.model,
          promptVersion: entry.prompt?.version ?? null,
        });
      } catch (error) {
        const refused = error instanceof Refused ? error : new Refused('model_failed');
        if (refused.verdict !== 'not_screened') line.verdict = refused.verdict;
        try {
          await settle(refused.code);
        } catch {
          // The budget layer's own error; the reservation stays as it was and the sweeper settles it.
        }
        const known = REFUSALS[refused.code];
        return finish({
          ok: false,
          refusal: { code: refused.code, retryable: refused.retryable ?? known.retryable, message: known.message },
        });
      }
    });
  }

  return { call };
}
