import { z } from 'zod';
import { OperatorContextError } from '@/db/tenant';
import type { Operator } from '@/lib/auth';
import { PARTS, RecordsCheckError, type Cursor, type RecordsCheckInput } from './service';
import { recordsCheckServices } from './services';

// POST /api/platform/companies/{companyId}/records-check (S8-3), wrapped in operatorRoute with a
// fresh sign-in by its route file. The company comes from the path; a company id that names no
// company is not found. The body is empty ({}) for a run's first page, then { runId, next } with the
// cursor the previous page answered.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const id = z.string().regex(UUID);
const sealed = z.strictObject({ sealed: z.string().regex(/^[A-Za-z0-9_-]{39,2048}$/) });
const cursor = z
  .strictObject({ part: z.enum(PARTS), after: z.union([id, sealed, z.null()]) })
  // Only the objects part continues from a sealed name; every other part pages by id.
  .refine((c) =>
    c.part === 'objects'
      ? typeof c.after !== 'string'
      : typeof c.after !== 'object' || c.after === null,
  );
const checkBody = z.union([z.strictObject({}), z.strictObject({ runId: id, next: cursor })]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function recordsCheck(
  request: Request,
  operator: Operator,
  context: RouteContext,
): Promise<Response> {
  try {
    const companyId = (await context.params).companyId;
    if (typeof companyId !== 'string' || !UUID.test(companyId.toLowerCase()))
      return json({ error: 'not_found' }, 404);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: 'invalid_request' }, 400);
    }
    const parsed = checkBody.safeParse(raw);
    if (!parsed.success) return json({ error: 'invalid_request' }, 400);
    const input: RecordsCheckInput =
      'runId' in parsed.data ? { runId: parsed.data.runId, next: parsed.data.next as Cursor } : {};
    return json(
      await recordsCheckServices().check(operator.operatorId, companyId.toLowerCase(), input),
    );
  } catch (error) {
    if (error instanceof RecordsCheckError) return json({ error: error.code }, error.status);
    // The operator was disabled after the sign-in check: refuse as on every other operator route.
    if (error instanceof OperatorContextError) return json({ error: 'not_an_operator' }, 403);
    // Fixed text only: an error from a store may quote an object path.
    console.error('records check unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'records_check_unavailable' }, 503);
  }
}
