import { AgreementError } from '@/lib/agreements/errors';
import { IdentityRefusal, type Identity, type LinkToken } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { PhotoError } from '@/lib/photos/errors';
import { readBody, TooLarge } from '@/lib/photos/image';
import type { PhotoStream } from '@/lib/photos/service';
import { LinkError } from './errors';
import { createDocumentLinkBody, createSigningLinkBody, linkSignBody } from './schema';
import { documentLinksServices, signingLinksServices } from './services';
import { LINK_SIGNATURE_BYTES } from './signing';

// The link routes (S5a-11b). The technician's side (src/app/api/jobs/[jobId]/signing-link and
// document-links) is wrapped in requireFlag('price_books', ...) as the estimate and signing routes
// are; the homeowner's and adjuster's side (src/app/api/sign, src/app/api/documents) in linkRoute,
// which hands over only the token's SHA-256. No answer here is cached, and no page sends a referrer.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}

// A photo-route refusal as a link answers it: the job and photo codes of the technician's routes
// say nothing a homeowner can act on, so only the signature's own problems pass through.
function photoRefusal(error: PhotoError): Response {
  if (error.code === 'too_large' || error.code === 'unsupported_image' || error.code === 'invalid_request') return json({ error: error.code }, error.status);
  if (error.code === 'photo_conflict') return json({ error: 'conflict' }, 409);
  if (error.code === 'not_ready_to_sign') return json({ error: 'link_voided' }, 410);
  if (error.code === 'not_found') return json({ error: 'link_unavailable' }, 404);
  return json({ error: 'links_unavailable' }, 503);
}

async function respond(run: () => Promise<Response>, link = false): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LinkError) return json({ error: error.code }, error.status);
    // Making a signing link applies signing's own checks; the technician's phone reads their codes.
    if (error instanceof AgreementError && !link) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof PhotoError) return photoRefusal(error);
    // On a link, a job refusal means the technician can no longer act for the job.
    if (error instanceof JobError) return link ? json({ error: 'link_unavailable' }, 404) : json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database may quote a value, such as a name or a hash.
    console.error('links request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'links_unavailable' }, 503);
  }
}

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new LinkError('invalid_request');
  }
}

async function param(context: RouteContext, name: string, missing: () => Error): Promise<string> {
  const value = (await context.params)[name];
  if (typeof value !== 'string' || !UUID.test(value)) throw missing();
  return value.toLowerCase();
}

const jobIdOf = (context: RouteContext) => param(context, 'jobId', () => new JobError('not_found'));

function image(found: PhotoStream): Response {
  return new Response(found.body as ReadableStream<Uint8Array>, {
    headers: {
      ...HEADERS,
      'Content-Type': found.contentType,
      'Content-Length': String(found.sizeBytes),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

// --- The technician's side -------------------------------------------------------------------------

// POST /api/jobs/{jobId}/signing-link  { id, estimateId, proposalSha256 }
// 201 and the token (shown once) for a new link; 200 and a new token for the same request again (the
// token of the first answer stops working). The job's older pending link, if any, is revoked.
export async function createSigningLink(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const jobId = await jobIdOf(context);
    const parsed = createSigningLinkBody.safeParse(await bodyOf(request));
    if (!parsed.success) throw new LinkError('invalid_request');
    const { created, link, token } = await signingLinksServices().create(identity, jobId, parsed.data);
    return json({ link, token }, created ? 201 : 200);
  });
}

// GET /api/jobs/{jobId}/signing-link: the job's newest link and its state now, never its token.
export async function readSigningLink(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => json(await signingLinksServices().current(identity, await jobIdOf(context))));
}

// DELETE /api/jobs/{jobId}/signing-link: revokes the job's pending link; the same request again
// changes nothing.
export async function revokeSigningLink(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => json(await signingLinksServices().revoke(identity, await jobIdOf(context))));
}

// POST /api/jobs/{jobId}/document-links  { id, set: 'homeowner' | 'adjuster' }
// Both sets' links are made at signing; this makes one again: the owner or office (who may replace a
// working one), or whoever may sign once the set has no working link (409 `link_active` otherwise).
// The same id and body again answers a new token to the owner or office only (403 otherwise). The
// answer also carries the job's document links as they now are, as GET reads them.
export async function createDocumentLink(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const jobId = await jobIdOf(context);
    const parsed = createDocumentLinkBody.safeParse(await bodyOf(request));
    if (!parsed.success) throw new LinkError('invalid_request');
    const { created, link, token, links } = await documentLinksServices().create(identity, jobId, parsed.data);
    return json({ link, token, links }, created ? 201 : 200);
  });
}

// GET /api/jobs/{jobId}/document-links: the job's document links and their state, never a token.
export async function listDocumentLinks(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => json(await documentLinksServices().list(identity, await jobIdOf(context))));
}

// DELETE /api/jobs/{jobId}/document-links/{linkId}: owner or office. The answer carries the link and
// the job's document links as they now are.
export async function revokeDocumentLink(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const jobId = await jobIdOf(context);
    const linkId = await param(context, 'linkId', () => new JobError('not_found'));
    return json(await documentLinksServices().revoke(identity, jobId, linkId));
  });
}

// --- The homeowner's and adjuster's side ------------------------------------------------------------

// GET /api/sign: what the link shows: the documents to sign, or the signed record after signing.
export async function viewSigningLink(_request: Request, link: LinkToken): Promise<Response> {
  return respond(async () => json(await signingLinksServices().view(link.tokenSha256)), true);
}

// POST /api/sign  { id, signatureId, signerName, signerRole, documentsConfirmed: true, electronicConsent: true }
// 201 when this request signed; 200 for the same request again. The answer that signed carries the
// tokens of the document links made at signing, once; the same request again carries none.
export async function signWithLink(request: Request, link: LinkToken): Promise<Response> {
  return respond(async () => {
    const parsed = linkSignBody.safeParse(await bodyOf(request));
    if (!parsed.success) throw new LinkError('invalid_request');
    const { created, agreement, documentLinks } = await signingLinksServices().sign(link.tokenSha256, parsed.data);
    return json({ agreement, documentLinks }, created ? 201 : 200);
  }, true);
}

// PUT /api/sign/signature/{signatureId}  (the drawn signature, PNG, at most 1 MiB)
export async function sendLinkSignature(request: Request, link: LinkToken, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const signatureId = await param(context, 'signatureId', () => new LinkError('invalid_request'));
    const { created, receipt } = await signingLinksServices().receiveSignature(link.tokenSha256, signatureId, {
      readBytes: async () => {
        try {
          return await readBody(request, LINK_SIGNATURE_BYTES);
        } catch (error) {
          if (error instanceof TooLarge) throw new LinkError('too_large');
          throw error;
        }
      },
    });
    return json({ signatureId: receipt.photoId, sha256: receipt.sha256 }, created ? 201 : 200);
  }, true);
}

// GET /api/sign/signature: the signature of a used link's signed record.
export async function readLinkSignature(_request: Request, link: LinkToken): Promise<Response> {
  return respond(async () => image(await signingLinksServices().openSignature(link.tokenSha256)), true);
}

// GET /api/sign/photos/{photoId}: one photo of the record the link shows, by the id its photo log
// carries; only a photo of that submitted record, on the link's own job.
export async function readLinkPhoto(_request: Request, link: LinkToken, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const photoId = await param(context, 'photoId', () => new LinkError('link_unavailable'));
    return image(await signingLinksServices().openPhoto(link.tokenSha256, photoId));
  }, true);
}

// GET /api/documents: the document set the link opens.
export async function viewDocumentLink(_request: Request, link: LinkToken): Promise<Response> {
  return respond(async () => json(await documentLinksServices().view(link.tokenSha256)), true);
}

// GET /api/documents/signature: the signature on the homeowner's set.
export async function readDocumentSignature(_request: Request, link: LinkToken): Promise<Response> {
  return respond(async () => image(await documentLinksServices().openSignature(link.tokenSha256)), true);
}

// GET /api/documents/photos/{photoId}: one photo of the homeowner's set, as /api/sign/photos.
export async function readDocumentPhoto(_request: Request, link: LinkToken, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const photoId = await param(context, 'photoId', () => new LinkError('link_unavailable'));
    return image(await documentLinksServices().openPhoto(link.tokenSha256, photoId));
  }, true);
}
