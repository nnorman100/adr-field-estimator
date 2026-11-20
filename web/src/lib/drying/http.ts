import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { DryingError } from './errors';
import { listQuery } from './schema';
import { dryingServices } from './services';

// The drying log routes (src/app/api/jobs/[jobId]/drying-readings/). Each route file wraps one of these
// in memberRoute; the company comes only from the verified sign-in, and the path names the job and the
// reading and nothing else. Every answer is no-store.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The largest valid reading is a few thousand characters even with every character of its notes
// written as a \u escape; a body over this is refused before it is parsed.
const MAX_BODY_LENGTH = 16_384;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DryingError || error instanceof JobError) return json({ error: error.code }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database may quote a value.
    console.error('drying log request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'drying_unavailable' }, 503);
  }
}

// The job's path id: a uuid, or the job does not exist.
async function jobPathId(context: RouteContext): Promise<string> {
  const value = (await context.params).jobId;
  if (typeof value !== 'string' || !UUID.test(value)) throw new JobError('not_found');
  return value.toLowerCase();
}

// The reading's path id, lower-cased; one that is not a uuid names no reading, which the service
// answers after the job's own checks (so an archived job is 410 whatever the reading id).
async function readingPathId(context: RouteContext): Promise<string> {
  const value = (await context.params).readingId;
  return typeof value === 'string' ? value.toLowerCase() : '';
}

// The body as JSON, unchecked: the service checks the caller's access to the job before it checks the
// body's fields.
async function rawBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_LENGTH) throw new DryingError('invalid_request');
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new DryingError('invalid_request');
  }
  if (text.length > MAX_BODY_LENGTH) throw new DryingError('invalid_request');
  try {
    return JSON.parse(text);
  } catch {
    throw new DryingError('invalid_request');
  }
}

// GET /api/jobs/{jobId}/drying-readings?limit=&cursor=
export async function listReadings(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobPathId(context);
    const query = listQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new DryingError('invalid_request');
    return json(await dryingServices().readings.list(identity, id, query.data));
  });
}

// POST /api/jobs/{jobId}/drying-readings  { id, kind, roomId?, takenAt, ... }: 201 for a new reading,
// 200 with the stored reading for the same request again.
export async function addReading(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobPathId(context);
    const raw = await rawBody(request);
    const { created, reading } = await dryingServices().readings.add(identity, id, raw);
    return json({ reading }, created ? 201 : 200);
  });
}

// POST /api/jobs/{jobId}/drying-readings/{readingId}/void  { changeId }: the void's receipt, the same
// for the same request again.
export async function voidReading(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobPathId(context);
    const readingId = await readingPathId(context);
    const raw = await rawBody(request);
    return json({ void: await dryingServices().readings.void(identity, id, readingId, raw) });
  });
}
