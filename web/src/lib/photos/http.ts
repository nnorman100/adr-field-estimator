import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { PhotoError } from './errors';
import { readBody, TooLarge } from './image';
import { photosServices } from './services';
import type { PhotoKind } from './service';

// The photo routes (src/app/api/jobs/[jobId]/photos/[photoId]/route.ts). Each is wrapped in
// memberRoute there; these add the job and photo rules. The company comes only from the verified
// sign-in: no path, query, header or body names one.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PhotoError) return json({ error: error.code }, error.status);
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database or the bucket may quote a path or a name.
    console.error('photos request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'photos_unavailable' }, 503);
  }
}

// The job id is a uuid or the job does not exist (as in src/lib/jobs/http.ts); the photo id is the
// phone's own uuid, so a bad one is a bad request.
async function ids(context: RouteContext): Promise<{ jobId: string; photoId: string }> {
  const { jobId, photoId } = await context.params;
  if (typeof jobId !== 'string' || !UUID.test(jobId)) throw new JobError('not_found');
  if (typeof photoId !== 'string' || !UUID.test(photoId)) throw new PhotoError('invalid_request');
  return { jobId: jobId.toLowerCase(), photoId: photoId.toLowerCase() };
}

function kindOf(request: Request, fallback: PhotoKind | null): PhotoKind {
  const kind = new URL(request.url).searchParams.getAll('kind');
  if (kind.length === 0 && fallback) return fallback;
  if (kind.length === 1 && (kind[0] === 'photo' || kind[0] === 'original' || kind[0] === 'signature')) return kind[0];
  throw new PhotoError('invalid_request');
}

// PUT /api/jobs/{jobId}/photos/{photoId}?kind=photo|original|signature  (the raw image as the body)
// 201 for a new photo, 200 for the same bytes again; the answer is the receipt. An original also
// sends X-Photo-Sha256: the SHA-256 of the registered photo it belongs to; a signature sends X-Proposal-Sha256: the SHA-256 of the proposal it was drawn for.
export async function putPhoto(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const { jobId, photoId } = await ids(context);
    const kind = kindOf(request, null);
    const photoSha256 = request.headers.get('x-photo-sha256');
    if (kind === 'original' && (photoSha256 === null || !HEX_SHA256.test(photoSha256))) throw new PhotoError('invalid_request');
    const proposalSha256 = request.headers.get('x-proposal-sha256');
    if (proposalSha256 !== null && !HEX_SHA256.test(proposalSha256)) throw new PhotoError('invalid_request');
    const { created, receipt } = await photosServices().receive(identity, jobId, photoId, kind, {
      readBytes: async () => {
        try {
          return await readBody(request);
        } catch (error) {
          if (error instanceof TooLarge) throw new PhotoError('too_large');
          throw error;
        }
      },
      ...(kind === 'original' ? { photoSha256: photoSha256!.toLowerCase() } : {}),
      ...(kind === 'signature' && proposalSha256 !== null ? { proposalSha256: proposalSha256.toLowerCase() } : {}),
    });
    return json(receipt, created ? 201 : 200);
  });
}

// GET /api/jobs/{jobId}/photos/{photoId}?kind=photo|original|signature  (the photo when no kind is given)
export async function getPhoto(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const { jobId, photoId } = await ids(context);
    const kind = kindOf(request, 'photo');
    const found = await photosServices().open(identity, jobId, photoId, kind);
    return new Response(found.body as ReadableStream<Uint8Array>, {
      headers: {
        ...NO_STORE,
        'Content-Type': found.contentType,
        'Content-Length': String(found.sizeBytes),
        // The bytes are only ever shown as the image they are.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });
}
