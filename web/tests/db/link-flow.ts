import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { FieldManifest } from '@/lib/field/canonical';
import { flow, image, json, type Answer, type Routes } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// Shared by the signing-link and document-link tests (S5a-11b): a job of company A made, filled,
// submitted and priced through the real routes, as in agreements-api.test.ts, and the calls a
// technician and a homeowner make. The homeowner's calls carry only the link token, in its header.

type Route = (request: Request, context: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;

export type LinkRoutes = Routes & {
  customer: Route;
  estimate: Route;
  agreements: Route;
  signingLink: { POST: Route; GET: Route; DELETE: Route };
  sign: { GET: Route; POST: Route };
  signature: { PUT: Route };
  signedSignature: { GET: Route };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = Record<string, any>;
export type Reply = Answer & { body: Body };

// The company's own wording for the signed page (synthetic; DryScope ships no wording of its own).
export const AUTHORIZATION = '  Synthetic start-work authorization, line one.\n\nLine two, after a blank line.';
export const PAYMENT_TERMS = 'Synthetic payment terms:\n  - half at start\n  - half at completion';

export const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
export const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
export const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
export const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };

export function linkFlow(h: () => Harness, routes: LinkRoutes, publish: (company: string, price: string) => Promise<unknown>) {
  const { request, params } = routes;
  const f = flow(h, routes);

  // A request from the homeowner's browser: no sign-in, the token in its header only.
  function linkRequest(token: string | null, path: string, init: { method?: string; body?: unknown } = {}): Request {
    const built = request(null, path, init);
    if (token !== null) built.headers.set('x-link-token', token);
    return built;
  }

  async function setUp(): Promise<void> {
    await h().admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h().seed.a}, 'price_books', true), (${h().seed.b}, 'price_books', true)`;
    await h().admin`
      UPDATE companies SET profile_address = '1 Synthetic Way, Testville', profile_phone = '555-0100', profile_email = 'office@example.invalid',
        profile_license = '000001', profile_signoff = 'Pat Example',
        profile_documents = ${JSON.stringify({ authorization_text: AUTHORIZATION, payment_terms_text: PAYMENT_TERMS })}::text::jsonb
      WHERE id = ${h().seed.a}
    `;
  }

  function manifestOf(photoId: string): FieldManifest {
    return {
      draft: { yearBuilt: 1972, roomOrder: ['kitchen', 'hall'], summary: 'Category 2 water in two rooms.', scopeConfirmed: true },
      rooms: [
        { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
        { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40 } },
      ],
      photos: [{ id: photoId, field: { roomId: 'kitchen', shotTag: 'source' } }],
    };
  }

  async function saveCustomer(claims: FakeClaims, jobId: string, propertyAddress: string, name = 'Casey Customer') {
    const body = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), name, phone: '555-0101', email: 'casey@example.invalid', propertyAddress };
    return routes.customer(request(claims, `/api/jobs/${jobId}/customer`, { method: 'PUT', body }), params({ jobId }));
  }

  const price = (claims: FakeClaims, jobId: string): Promise<Reply> =>
    json(routes.estimate(request(claims, `/api/jobs/${jobId}/estimate`, { method: 'POST' }), params({ jobId })));

  // A submitted, priced job of company A: what a signing link needs.
  async function pricedJob(claims: FakeClaims = ESTIMATOR_A) {
    await publish(h().seed.a, '2.00');
    const ready = await f.readyJob(claims, h().seed.a);
    expect((await saveCustomer(claims, ready.jobId, '12 Synthetic Lane, Testville')).status).toBe(200);
    const manifest = manifestOf(ready.photoId);
    h().field.put(h().seed.a, ready.draftId, manifest);
    expect((await f.submitShown(claims, ready.jobId, ready.draftId, manifest)).answer.status).toBe(201);
    const estimate = (await price(claims, ready.jobId)).body.estimate as Body;
    expect(estimate.documents.signable).toBe(true);
    return { ...ready, manifest, estimate };
  }

  const makeLink = (claims: FakeClaims | null, jobId: string, body: unknown): Promise<Reply> =>
    json(routes.signingLink.POST(request(claims, `/api/jobs/${jobId}/signing-link`, { method: 'POST', body }), params({ jobId })));
  const linkStatus = (claims: FakeClaims | null, jobId: string): Promise<Reply> =>
    json(routes.signingLink.GET(request(claims, `/api/jobs/${jobId}/signing-link`), params({ jobId })));
  const revokeLink = (claims: FakeClaims | null, jobId: string): Promise<Reply> =>
    json(routes.signingLink.DELETE(request(claims, `/api/jobs/${jobId}/signing-link`, { method: 'DELETE' }), params({ jobId })));

  const linkBody = (estimate: Body, id: string = randomUUID()) => ({ id, estimateId: estimate.id, proposalSha256: estimate.proposalSha256 });

  // A job with a link made for its estimate by `claims`, and the token.
  async function linkedJob(claims: FakeClaims = ESTIMATOR_A) {
    const job = await pricedJob(claims);
    const body = linkBody(job.estimate);
    const made = await makeLink(claims, job.jobId, body);
    expect(made.status).toBe(201);
    return { ...job, link: made.body.link as Body, linkId: body.id, token: made.body.token as string, body };
  }

  const view = (token: string | null): Promise<Reply> => json(routes.sign.GET(linkRequest(token, '/api/sign'), params({})));
  const sendSignature = (token: string | null, signatureId: string, bytes: Uint8Array): Promise<Reply> =>
    json(routes.signature.PUT(linkRequest(token, `/api/sign/signature/${signatureId}`, { method: 'PUT', body: bytes }), params({ signatureId })));
  const signWith = (token: string | null, body: unknown): Promise<Reply> => json(routes.sign.POST(linkRequest(token, '/api/sign', { method: 'POST', body }), params({})));
  const signBody = (signatureId: string, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    signatureId,
    signerName: 'Casey Customer',
    signerRole: 'homeowner',
    documentsConfirmed: true,
    electronicConsent: true,
    ...extra,
  });

  // The homeowner signs: the signature first, then the agreement.
  async function homeownerSigns(token: string, name = 'Casey Customer') {
    const signatureId = randomUUID();
    const bytes = image(`homeowner ${signatureId}`);
    expect((await sendSignature(token, signatureId, bytes)).status).toBe(201);
    const body = signBody(signatureId, { signerName: name });
    const answer = await signWith(token, body);
    return { answer, body, signatureId, bytes };
  }

  const linkRows = (jobId: string) =>
    h().admin<{ id: string; status: string; token_sha256: string; agreement_id: string | null; ended_by_actor_id: string | null; sign_attempts: number }[]>`
      SELECT id::text, status, token_sha256, agreement_id::text, ended_by_actor_id::text, sign_attempts FROM signing_links WHERE job_id = ${jobId} ORDER BY created_at, id
    `;
  const agreementRows = (jobId: string) =>
    h().admin<{ id: string; signer_kind: string; signer_name: string; signer_role: string | null; signing_link_id: string | null; created_by_actor_id: string; estimate_id: string; documents_bytes: Buffer }[]>`
      SELECT id::text, signer_kind, signer_name, signer_role, signing_link_id::text, created_by_actor_id::text, estimate_id::text, documents_bytes FROM agreements WHERE job_id = ${jobId}
    `;

  // Moves a link's clock back by `days` (creation, expiry and, when used, signing), as if made then.
  // The guard trigger keeps a link's times fixed, so the test steps around it as the table owner.
  async function age(table: 'signing_links' | 'document_links', id: string, days: number): Promise<void> {
    await h().admin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx.unsafe(
        `UPDATE ${table} SET created_at = created_at - make_interval(days => $1), expires_at = expires_at - make_interval(days => $1)${
          table === 'signing_links' ? ', used_at = used_at - make_interval(days => $1)' : ''
        } WHERE id = $2`,
        [days, id],
      );
    });
  }

  return {
    f,
    linkRequest,
    setUp,
    manifestOf,
    saveCustomer,
    price,
    pricedJob,
    makeLink,
    linkStatus,
    revokeLink,
    linkBody,
    linkedJob,
    view,
    sendSignature,
    signWith,
    signBody,
    homeownerSigns,
    linkRows,
    agreementRows,
    age,
  };
}
