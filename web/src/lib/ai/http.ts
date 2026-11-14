import { OperatorContextError } from '@/db/tenant';
import { IdentityRefusal, type Identity, type Operator } from '@/lib/auth';
import { aiBudgetServices } from './services';
import { AiSettingsError, aiSettingsInput } from './settings';

// The AI usage and AI settings routes (S7-4):
// - GET /api/companies/{companyId}/ai-usage, a memberRoute: the company in the path must be the
//   caller's own (else it does not exist, 404), then the caller must hold ai_usage_read (the owner;
//   else 403), and only then is the ledger read. The answer is AI spending against the ceilings,
//   never a price of the company's work.
// - PUT /api/platform/companies/{companyId}/ai-settings, an operatorRoute: sets the company's
//   ceilings with one audit row (settings.ts).
// A refused request reads and writes nothing.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_024;

class Refusal extends Error {
  constructor(
    readonly code: 'not_found' | 'not_allowed' | 'invalid_request',
    readonly status: number,
  ) {
    super(code);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function respond(what: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Refusal || error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    if (error instanceof AiSettingsError) return json({ error: error.code }, 404);
    // The operator was disabled after the sign-in check: refuse as on every other operator route.
    if (error instanceof OperatorContextError) return json({ error: 'not_an_operator' }, 403);
    // Fixed text only: a database error may quote a value.
    console.error(`${what} unavailable`, error instanceof Error ? error.name : 'unknown');
    return json({ error: `${what}_unavailable` }, 503);
  }
}

async function pathCompany(context: RouteContext): Promise<string> {
  const value = (await context.params).companyId;
  if (typeof value !== 'string' || !UUID.test(value)) throw new Refusal('not_found', 404);
  return value.toLowerCase();
}

// GET /api/companies/{companyId}/ai-usage
export async function readAiUsage(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond('ai_usage', async () => {
    const companyId = await pathCompany(context);
    if (companyId !== identity.companyId.toLowerCase()) throw new Refusal('not_found', 404);
    if (!identity.capabilities.includes('ai_usage_read')) throw new Refusal('not_allowed', 403);
    return json(await aiBudgetServices().usage(identity.companyId, new Date()));
  });
}

// PUT /api/platform/companies/{companyId}/ai-settings  { dailyCeilingMicroUsd, monthlyCeilingMicroUsd }
// Each is a whole number of micro-USD (1,000,000 is $1) or null for the default ($10 a day, $200 a
// month, owner decision V5 B).
export async function setAiSettings(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond('ai_settings', async () => {
    const companyId = await pathCompany(context);
    let raw: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) throw new Error('too long');
      raw = JSON.parse(text);
    } catch {
      throw new Refusal('invalid_request', 400);
    }
    const parsed = aiSettingsInput.safeParse(raw);
    if (!parsed.success) throw new Refusal('invalid_request', 400);
    return json(await aiBudgetServices().setCeilings(operator.operatorId, companyId, parsed.data));
  });
}
