import { z } from 'zod';
import type { Identity } from '@/lib/auth';
import { IdentityRefusal } from '@/lib/auth';
import { PricesError } from './service';
import { pricesServices } from './services';

// The Prices routes (src/app/api/prices/...). Each route file wraps one of these in requireFlag
// ('price_books', ...), so a company without price books gets 404 before anything here runs and the
// company comes from the verified sign-in alone: no route takes a company id. These add the price
// rules: everyone with prices_read reads the current prices (a reader sees the enabled items only),
// and every other route needs prices_manage, the owner's key, and is refused before the body or the
// database is read. Publishing also needs a sign-in under 15 minutes old, declared on its route.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A whole table is at most 150 items with their rows; far more than any real list.
const MAX_BODY_BYTES = 2_000_000;

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PricesError) {
      return json(
        {
          error: error.code,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
          ...(error.revision === undefined ? {} : { revision: error.revision }),
        },
        error.status,
      );
    }
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    if (error instanceof BadRequest) return json({ error: 'invalid_request' }, 400);
    // Fixed text only: an error from the database may quote a price or a reason.
    console.error('price change unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'prices_unavailable' }, 503);
  }
}

// A path id: a uuid, or the record does not exist.
async function pathId(context: RouteContext, name: string): Promise<string> {
  const value = (await context.params)[name];
  if (typeof value !== 'string' || !UUID.test(value)) throw new PricesError('not_found');
  return value.toLowerCase();
}

function requireManage(identity: Identity): string {
  if (!identity.capabilities.includes('prices_manage')) throw new PricesError('not_allowed');
  return identity.actorId;
}

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new BadRequest();
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new BadRequest();
  }
  if (text.length > MAX_BODY_BYTES) throw new BadRequest();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequest();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest();
  return parsed.data;
}

const revision = z.number().int().min(0).max(2_000_000_000);
const saveBody = z.strictObject({ expectedRevision: revision, table: z.unknown() });
const previewBody = z.strictObject({ table: z.unknown().optional() });
// The CSV file as text beside the revision it was read against (the whole body is under 2 MB).
const importBody = z.strictObject({ expectedRevision: revision, csv: z.string() });
const restoreBody = z.strictObject({ expectedRevision: revision });
// The owner's change reason, as migration 0009 checks it: 3 to 500 characters, no padding.
const reason = z
  .string()
  .trim()
  .refine((value) => Array.from(value).length >= 3 && Array.from(value).length <= 500)
  .refine((value) => !/\p{Cc}/u.test(value));
const publishBody = z.strictObject({
  expectedRevision: revision.min(1),
  reason,
  publishKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  confirmZeroPrices: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/))
    .max(150)
    .default([]),
  // The owner's range setting (Q14): needed at the first publish, optional after.
  rangeChoice: z.enum(['range', 'single']).optional(),
});

// GET /api/prices: the current prices; the owner also gets the working copy.
export async function readPrices(_request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    let view: 'owner' | 'reader';
    if (identity.capabilities.includes('prices_manage')) view = 'owner';
    else if (identity.capabilities.includes('prices_read')) view = 'reader';
    else throw new PricesError('not_allowed');
    return json(await pricesServices().read(identity.companyId, view));
  });
}

// PUT /api/prices/working-copy  { expectedRevision, table }
export async function saveWorkingCopy(request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    const actorId = requireManage(identity);
    const input = await body(request, saveBody);
    return json(await pricesServices().saveWorkingCopy(identity.companyId, actorId, input, new Date()));
  });
}

// POST /api/prices/preview  { table? }: prices the sample jobs; writes nothing.
export async function previewPrices(request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    requireManage(identity);
    const input = await body(request, previewBody);
    return json(await pricesServices().preview(identity.companyId, input.table));
  });
}

// POST /api/prices/publish  { expectedRevision, reason, publishKey, confirmZeroPrices?, rangeChoice? }
export async function publishPrices(request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    const actorId = requireManage(identity);
    const input = await body(request, publishBody);
    const published = await pricesServices().publish(identity.companyId, actorId, input, new Date());
    return json(published, published.replayed ? 200 : 201);
  });
}

// POST /api/prices/import  { expectedRevision, csv }: applies a price list to the working copy only.
export async function importPrices(request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    const actorId = requireManage(identity);
    const input = await body(request, importBody);
    return json(await pricesServices().importPriceList(identity.companyId, actorId, input, new Date()));
  });
}

// GET /api/prices/versions
export async function listVersions(_request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    requireManage(identity);
    return json(await pricesServices().listVersions(identity.companyId));
  });
}

// GET /api/prices/versions/{versionId}
export async function readVersion(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    requireManage(identity);
    return json(await pricesServices().readVersion(identity.companyId, await pathId(context, 'versionId')));
  });
}

// POST /api/prices/versions/{versionId}/restore  { expectedRevision }: into the working copy only.
export async function restoreVersion(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const actorId = requireManage(identity);
    const versionId = await pathId(context, 'versionId');
    const { expectedRevision } = await body(request, restoreBody);
    return json(await pricesServices().restore(identity.companyId, actorId, versionId, expectedRevision, new Date()));
  });
}

// GET /api/prices/export: the working copy as a CSV price list.
export async function exportPrices(_request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    requireManage(identity);
    const csv = await pricesServices().exportPriceList(identity.companyId);
    return new Response(csv, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="price-list.csv"',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
