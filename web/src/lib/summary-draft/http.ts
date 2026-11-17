import { z } from 'zod';
import { aiRefusalResponse } from '@/lib/ai/budget';
import type { AiRefusal } from '@/lib/ai/call';
import type { AiRefusalCode } from '@/lib/ai/codes';
import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { uuid } from '@/lib/jobs/schema';
import { readBody } from '@/lib/photos/image';
import { SummaryDraftError, SummaryDraftRefused } from './service';
import { summaryDraftServices } from './services';

// The summary draft route (src/app/api/jobs/[jobId]/ai/summary-draft), wrapped in memberRoute there.
// The company comes only from the verified sign-in: no path or body names one. The body is the
// phone's own call id, so a retry after a lost answer finds the same proposal.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_024;

export const summaryDraftBody = z.strictObject({ callId: uuid });

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

// How each AI refusal answers. A quota or budget refusal is a 429 with Retry-After (budget.ts); the
// rest carry the boundary's fixed words, whether to try again, and that field work goes on without AI.
const REFUSAL_STATUS: Readonly<Record<AiRefusalCode, number>> = {
  invalid_context: 403,
  not_allowed: 403,
  feature_off: 403,
  not_ready: 503,
  quota: 429,
  budget: 429,
  call_reused: 409,
  unsupported_input: 422,
  input_blocked: 422,
  output_blocked: 422,
  screen_unavailable: 503,
  model_timeout: 503,
  model_busy: 503,
  model_failed: 503,
  invalid_output: 503,
};

export function summaryRefusalResponse(refusal: AiRefusal): Response {
  const limited = aiRefusalResponse(refusal);
  if (limited) return limited;
  return json(
    {
      error: `ai_${refusal.code}`,
      message: refusal.message,
      retryable: refusal.retryable,
      fieldWorkContinues: true,
    },
    REFUSAL_STATUS[refusal.code],
  );
}

async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SummaryDraftRefused) return summaryRefusalResponse(error.refusal);
    if (error instanceof SummaryDraftError) return json({ error: error.code }, error.status);
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database or Firestore may quote a value.
    console.error('summary draft request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'summary_draft_unavailable' }, 503);
  }
}

// A path id: a uuid, or the job does not exist (as in src/lib/jobs/http.ts).
async function jobId(context: RouteContext): Promise<string> {
  const value = (await context.params).jobId;
  if (typeof value !== 'string' || !UUID.test(value)) throw new JobError('not_found');
  return value.toLowerCase();
}

async function body(request: Request): Promise<z.infer<typeof summaryDraftBody>> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(request, MAX_BODY_BYTES)));
  } catch {
    throw new SummaryDraftError('invalid_request');
  }
  const parsed = summaryDraftBody.safeParse(raw);
  if (!parsed.success) throw new SummaryDraftError('invalid_request');
  return parsed.data;
}

// POST /api/jobs/{jobId}/ai/summary-draft  { callId }
// 201 with the new proposal; 200 with the stored one for the same call id again. The proposal is
// never written to the draft here.
export async function draftSummary(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const { callId } = await body(request);
    const { created, result } = await summaryDraftServices().draft(identity, id, callId);
    return json({ result }, created ? 201 : 200);
  });
}
