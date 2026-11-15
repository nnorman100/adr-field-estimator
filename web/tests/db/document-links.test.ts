import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from './submission-flow';
import { AUTHORIZATION, ESTIMATOR_A, linkFlow, OFFICE_A, OWNER_A, OWNER_B, type Reply } from './link-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5a-11b, read-only document links (docs/plans/S5.md; docs/spec.md 2.5, "Your signed estimate
// documents"), through the real route files as the runtime role against Postgres. A job is signed
// through a signing link first (link-flow.ts); its document links then open the homeowner's or the
// adjuster's set of that signed record.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));
vi.mock('@/lib/estimates/services', async () => {
  const { estimatesService } = await import('@/lib/estimates/service');
  return { estimatesServices: () => estimatesService(live.harness!.handle.db) };
});
vi.mock('@/lib/agreements/services', async () => {
  const { agreementsService } = await import('@/lib/agreements/service');
  return { agreementsServices: () => agreementsService(live.harness!.handle.db) };
});
vi.mock('@/lib/links/services', async () => {
  const { signingLinksService } = await import('@/lib/links/signing');
  const { documentLinksService } = await import('@/lib/links/documents');
  return {
    signingLinksServices: () => signingLinksService(live.harness!.handle.db, live.harness!.photos),
    documentLinksServices: () => documentLinksService(live.harness!.handle.db, live.harness!.photos),
  };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const agreementsRoute = await import('@/app/api/jobs/[jobId]/agreements/route');
const signingLinkRoute = await import('@/app/api/jobs/[jobId]/signing-link/route');
const documentLinksRoute = await import('@/app/api/jobs/[jobId]/document-links/route');
const documentLinkRoute = await import('@/app/api/jobs/[jobId]/document-links/[linkId]/route');
const signRoute = await import('@/app/api/sign/route');
const signatureRoute = await import('@/app/api/sign/signature/[signatureId]/route');
const signedSignatureRoute = await import('@/app/api/sign/signature/route');
const documentsRoute = await import('@/app/api/documents/route');
const documentSignatureRoute = await import('@/app/api/documents/signature/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

async function publish(company: string, price: string) {
  const table = parseTable({
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: price }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
  });
  const owner = company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor;
  await h.admin`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    SELECT ${company}, coalesce(max(sequence), 0) + 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(table)}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${owner}, ${`key-${randomUUID()}`}
    FROM price_table_versions WHERE company_id = ${company}
  `;
}

const l = linkFlow(
  () => h,
  {
    createJob: jobsRoute.POST,
    putPhoto: photoRoute.PUT,
    submit: submissionsRoute.POST,
    nextDraft: draftsRoute.POST,
    request,
    params,
    customer: customerRoute.PUT,
    estimate: estimateRoute.POST,
    agreements: agreementsRoute.POST,
    signingLink: signingLinkRoute,
    sign: signRoute,
    signature: signatureRoute,
    signedSignature: signedSignatureRoute,
  },
  publish,
);

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  await l.setUp();
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const make = (claims: FakeClaims | null, jobId: string, body: unknown): Promise<Reply> =>
  json(documentLinksRoute.POST(request(claims, `/api/jobs/${jobId}/document-links`, { method: 'POST', body }), params({ jobId })));
const list = (claims: FakeClaims | null, jobId: string): Promise<Reply> => json(documentLinksRoute.GET(request(claims, `/api/jobs/${jobId}/document-links`), params({ jobId })));
const revoke = (claims: FakeClaims | null, jobId: string, linkId: string): Promise<Reply> =>
  json(documentLinkRoute.DELETE(request(claims, `/api/jobs/${jobId}/document-links/${linkId}`, { method: 'DELETE' }), params({ jobId, linkId })));
const open = (token: string | null): Promise<Reply> => json(documentsRoute.GET(l.linkRequest(token, '/api/documents'), params({})));
const signatureOf = (token: string) => documentSignatureRoute.GET(l.linkRequest(token, '/api/documents/signature'), params({}));

// A job of company A signed through a link.
async function signedJob() {
  const job = await l.linkedJob();
  const signed = await l.homeownerSigns(job.token);
  expect(signed.answer.status).toBe(201);
  return { ...job, record: signed.answer.body.agreement.record, signatureBytes: signed.bytes };
}

async function documentLink(claims: FakeClaims, jobId: string, set: 'homeowner' | 'adjuster', id = randomUUID()) {
  const made = await make(claims, jobId, { id, set });
  expect(made.status).toBe(201);
  return { id, token: made.body.token as string, link: made.body.link };
}

describe('document links', () => {
  it('are made for a signed job only, by someone who may sign, and answer the token once', async () => {
    const unsigned = await l.pricedJob();
    expect(await make(ESTIMATOR_A, unsigned.jobId, { id: randomUUID(), set: 'homeowner' })).toMatchObject({ status: 409, body: { error: 'not_signed' } });
    const { jobId } = await signedJob();
    expect(await make(OFFICE_A, jobId, { id: randomUUID(), set: 'homeowner' })).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await make(OWNER_B, jobId, { id: randomUUID(), set: 'homeowner' })).toMatchObject({ status: 404 });
    expect(await make(ESTIMATOR_A, jobId, { id: randomUUID(), set: 'everything' })).toMatchObject({ status: 400 });
    const { token, link, id } = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    expect(link).toMatchObject({ id, set: 'homeowner', status: 'active' });
    expect(Date.parse(link.expiresAt) - Date.parse(link.createdAt)).toBe(30 * 86_400_000);
    const [row] = await h.admin<{ token_sha256: string }[]>`SELECT token_sha256 FROM document_links WHERE id = ${id}`;
    expect(row!.token_sha256).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(await h.admin`SELECT * FROM document_links`)).not.toContain(token);
    const listed = await list(OFFICE_A, jobId);
    expect(listed).toMatchObject({ status: 200, body: { links: [{ id, set: 'homeowner', status: 'active' }] } });
    expect(JSON.stringify(listed.body)).not.toContain(token);
  });

  it('opens the homeowner’s set: the signed proposal with who signed, the photo log and the signature', async () => {
    const { jobId, record, signatureBytes } = await signedJob();
    const { token } = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    const page = await open(token);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ set: 'homeowner', proposalSha256: record.proposal_sha256, signed: { name: 'Casey Customer', signedAt: record.signed_at } });
    expect(page.body.proposal).toEqual(record.proposal);
    expect(page.body.proposal.authorization_text).toBe(AUTHORIZATION);
    expect(page.body.photoLog).toEqual(record.documents.photo_log);
    expect(page.body).not.toHaveProperty('itemizedClaim');
    expect(page.body).not.toHaveProperty('letter');
    const image = await signatureOf(token);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(signatureBytes);
    // Read any number of times.
    expect((await open(token)).status).toBe(200);
  });

  it('opens the adjuster’s set: the itemized claim, the scope defense letter and the claim, without the proposal or signature', async () => {
    const { jobId, record } = await signedJob();
    const { token } = await documentLink(OWNER_A, jobId, 'adjuster');
    const page = await open(token);
    expect(page).toMatchObject({ status: 200, body: { set: 'adjuster', itemizedClaim: record.documents.itemized_claim, letter: record.documents.letter, claim: record.documents.claim } });
    expect(page.body).not.toHaveProperty('proposal');
    expect(JSON.stringify(page.body)).not.toContain(AUTHORIZATION.trim());
    expect((await signatureOf(token)).status).toBe(404);
  });

  it('are revocable by the owner or office, not the estimator; a revoked link is unavailable', async () => {
    const { jobId } = await signedJob();
    const first = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    expect(await revoke(ESTIMATOR_A, jobId, first.id)).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await revoke(OWNER_B, jobId, first.id)).toMatchObject({ status: 404 });
    expect(await revoke(OFFICE_A, jobId, first.id)).toMatchObject({ status: 200, body: { link: { id: first.id, status: 'revoked' } } });
    expect(await open(first.token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await signatureOf(first.token)).status).toBe(404);
    const second = await documentLink(ESTIMATOR_A, jobId, 'adjuster');
    expect(await revoke(OWNER_A, jobId, second.id)).toMatchObject({ status: 200, body: { link: { status: 'revoked' } } });
    expect(await revoke(OWNER_A, jobId, second.id)).toMatchObject({ status: 200, body: { link: { status: 'revoked' } } });
    expect(await revoke(OWNER_A, jobId, randomUUID())).toMatchObject({ status: 404 });
    expect(await l.f.auditActions(jobId)).toEqual(expect.arrayContaining(['document_link_created', 'document_link_revoked']));
  });

  it('keep one active link per set: a newer one revokes the older; a retried create replaces the token', async () => {
    const { jobId } = await signedJob();
    const older = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    const adjuster = await documentLink(ESTIMATOR_A, jobId, 'adjuster');
    const newer = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    expect((await open(older.token)).status).toBe(404);
    expect((await open(adjuster.token)).status).toBe(200);
    expect((await open(newer.token)).status).toBe(200);
    const again = await make(ESTIMATOR_A, jobId, { id: newer.id, set: 'homeowner' });
    expect(again.status).toBe(200);
    expect((await open(newer.token)).status).toBe(404);
    expect((await open(again.body.token)).status).toBe(200);
    expect(await make(ESTIMATOR_A, jobId, { id: newer.id, set: 'adjuster' })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await make(ESTIMATOR_A, jobId, { id: older.id, set: 'homeowner' })).toMatchObject({ status: 409, body: { error: 'link_ended' } });
  });

  it('are unavailable after 30 days, or once the technician who made them no longer holds sign', async () => {
    const { jobId } = await signedJob();
    const aged = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    await l.age('document_links', aged.id, 30);
    expect(await open(aged.token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await list(OWNER_A, jobId)).body.links[0]).toMatchObject({ id: aged.id, status: 'expired' });
    const fresh = await documentLink(ESTIMATOR_A, jobId, 'adjuster');
    await h.admin`UPDATE memberships SET role = 'office' WHERE id = ${h.seed.estimatorA.membership}`;
    expect(await open(fresh.token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
  });

  it('a document link of company A opens nothing of company B and is no sign-in anywhere', async () => {
    const { jobId } = await signedJob();
    const { token } = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    const asBearer = request(null, `/api/jobs/${jobId}/document-links`);
    asBearer.headers.set('Authorization', `Bearer ${token}`);
    expect((await documentLinksRoute.GET(asBearer, params({ jobId }))).status).toBe(401);
    // A signing-link route does not take a document link's token, nor the other way round.
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    const page = JSON.stringify((await open(token)).body);
    expect(page).not.toContain(h.seed.b);
  });

  it('a used signing link’s token opens no document set', async () => {
    const { token } = await signedJob();
    expect(await open(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await signatureOf(token)).status).toBe(404);
  });
});
