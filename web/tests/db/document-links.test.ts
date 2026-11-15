import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { image, json } from './submission-flow';
import { AUTHORIZATION, ESTIMATOR_A, linkFlow, OFFICE_A, OWNER_A, OWNER_B, type Reply } from './link-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5a-11b, read-only document links (docs/plans/S5.md; docs/spec.md 2.5, "Your signed estimate
// documents"), through the real route files as the runtime role against Postgres. A job is signed
// through a signing link (link-flow.ts) or on the phone; the signing transaction makes the record's
// two document links, which open the homeowner's or the adjuster's set of that signed record.
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
const documentPhotoRoute = await import('@/app/api/documents/photos/[photoId]/route');
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
const photoOf = (token: string, photoId: string) => documentPhotoRoute.GET(l.linkRequest(token, `/api/documents/photos/${photoId}`), params({ photoId }));

type Issued = { link: { id: string; set: 'homeowner' | 'adjuster'; status: string; createdAt: string; expiresAt: string }; token: string };
const issuedOf = (answer: Reply): Record<'homeowner' | 'adjuster', Issued> =>
  Object.fromEntries((answer.body.documentLinks as Issued[]).map((issued) => [issued.link.set, issued])) as Record<'homeowner' | 'adjuster', Issued>;

// A job of company A signed through a link, with the document links made at signing.
async function signedJob() {
  const job = await l.linkedJob();
  const signed = await l.homeownerSigns(job.token);
  expect(signed.answer.status).toBe(201);
  return { ...job, signed, record: signed.answer.body.agreement.record, signatureBytes: signed.bytes, issued: issuedOf(signed.answer) };
}

// A job of company A signed on the technician's phone.
async function phoneSigned() {
  const job = await l.pricedJob();
  const signatureId = randomUUID();
  const sent = await json(
    photoRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${job.jobId}/photos/${signatureId}?kind=signature`, { method: 'PUT', body: image('phone') }), params({ jobId: job.jobId, photoId: signatureId })),
  );
  expect(sent.status).toBe(201);
  const body = { id: randomUUID(), estimateId: job.estimate.id, proposalSha256: job.estimate.proposalSha256, signatureId, signerName: 'Casey Customer', documentsConfirmed: true };
  const sign = (claims: FakeClaims = ESTIMATOR_A) =>
    json(agreementsRoute.POST(request(claims, `/api/jobs/${job.jobId}/agreements`, { method: 'POST', body }), params({ jobId: job.jobId })));
  return { ...job, sign };
}

async function documentLink(claims: FakeClaims, jobId: string, set: 'homeowner' | 'adjuster', id = randomUUID()) {
  const made = await make(claims, jobId, { id, set });
  expect(made.status).toBe(201);
  return { id, token: made.body.token as string, link: made.body.link };
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

describe('document links made at signing', () => {
  it('a link signature makes both sets’ links as the technician the link acts as, and answers their tokens once', async () => {
    const { jobId, issued, signed } = await signedJob();
    expect(Object.keys(issued).sort()).toEqual(['adjuster', 'homeowner']);
    expect(signed.answer.body.documentLinks).toHaveLength(2);
    const rows = await h.admin<{ id: string; document_set: string; token_sha256: string; created_by_actor_id: string; status: string }[]>`
      SELECT id::text, document_set, token_sha256, created_by_actor_id::text, status FROM document_links WHERE job_id = ${jobId} ORDER BY document_set
    `;
    expect(rows.map((row) => [row.document_set, row.status, row.created_by_actor_id])).toEqual([
      ['adjuster', 'active', h.seed.estimatorA.actor],
      ['homeowner', 'active', h.seed.estimatorA.actor],
    ]);
    for (const set of ['homeowner', 'adjuster'] as const) {
      expect(rows.find((row) => row.document_set === set)!.token_sha256).toBe(hash(issued[set].token));
      expect(Date.parse(issued[set].link.expiresAt) - Date.parse(issued[set].link.createdAt)).toBe(30 * 86_400_000);
      expect((await open(issued[set].token)).body.set).toBe(set);
    }
    expect(JSON.stringify(await h.admin`SELECT * FROM document_links`)).not.toContain(issued.homeowner.token);
    const listed = await list(OFFICE_A, jobId);
    expect(listed.body.links.map((link: { set: string; status: string }) => [link.set, link.status]).sort()).toEqual([
      ['adjuster', 'active'],
      ['homeowner', 'active'],
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(issued.homeowner.token);
    expect(signed.answer.body.agreement.record.signer).toEqual({ name: 'Casey Customer', role: 'homeowner' });
  });

  it('the same signing request again answers the same agreement and no token, and the shared links keep working', async () => {
    const { token, signed, issued, jobId } = await signedJob();
    const again = await l.signWith(token, signed.body);
    expect(again.status).toBe(200);
    expect(again.body.agreement.id).toBe(signed.answer.body.agreement.id);
    expect(again.body.documentLinks).toEqual([]);
    expect((await open(issued.homeowner.token)).status).toBe(200);
    expect((await open(issued.adjuster.token)).status).toBe(200);
    expect(await l.f.auditActions(jobId)).not.toContain('document_link_reissued');
  });

  it('signing on the phone makes them too, for the technician to share, and a retried signature replaces no token', async () => {
    const job = await phoneSigned();
    const first = await job.sign();
    expect(first.status).toBe(201);
    const issued = issuedOf(first);
    expect((await open(issued.homeowner.token)).body).toMatchObject({ set: 'homeowner', signed: { name: 'Casey Customer' } });
    expect((await open(issued.homeowner.token)).body.signed).not.toHaveProperty('role');
    expect((await open(issued.adjuster.token)).body.set).toBe('adjuster');
    const again = await job.sign();
    expect(again.status).toBe(200);
    expect(again.body.documentLinks).toEqual([]);
    expect((await open(issued.homeowner.token)).status).toBe(200);
    expect((await open(issued.adjuster.token)).status).toBe(200);
    expect(await h.admin`SELECT 1 FROM document_links WHERE job_id = ${job.jobId}`).toHaveLength(2);
  });

  it('the same signing request sent by someone else answers the agreement but renews none of the technician’s tokens', async () => {
    const job = await phoneSigned();
    const issued = issuedOf(await job.sign());
    const asOwner = await job.sign(OWNER_A);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.documentLinks).toEqual([]);
    expect((await open(issued.homeowner.token)).status).toBe(200);
    expect((await open(issued.adjuster.token)).status).toBe(200);
  });
});

describe('document links', () => {
  it('open the homeowner’s set: the signed proposal with who signed and their role, the photo log and the signature', async () => {
    const { record, signatureBytes, issued } = await signedJob();
    const page = await open(issued.homeowner.token);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ set: 'homeowner', proposalSha256: record.proposal_sha256, signed: { name: 'Casey Customer', role: 'homeowner', signedAt: record.signed_at } });
    expect(page.body.proposal).toEqual(record.proposal);
    expect(page.body.proposal.authorization_text).toBe(AUTHORIZATION);
    expect(page.body.photoLog).toEqual(record.documents.photo_log);
    expect(page.body).not.toHaveProperty('itemizedClaim');
    expect(page.body).not.toHaveProperty('letter');
    const image = await signatureOf(issued.homeowner.token);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(signatureBytes);
    // Read any number of times.
    expect((await open(issued.homeowner.token)).status).toBe(200);
  });

  it('open the adjuster’s set: the itemized claim, the scope defense letter and the claim, without the proposal, signature or photos', async () => {
    const { record, issued, photoId } = await signedJob();
    const page = await open(issued.adjuster.token);
    expect(page).toMatchObject({ status: 200, body: { set: 'adjuster', itemizedClaim: record.documents.itemized_claim, letter: record.documents.letter, claim: record.documents.claim } });
    expect(page.body).not.toHaveProperty('proposal');
    expect(JSON.stringify(page.body)).not.toContain(AUTHORIZATION.trim());
    expect((await signatureOf(issued.adjuster.token)).status).toBe(404);
    expect((await photoOf(issued.adjuster.token, photoId)).status).toBe(404);
  });

  it('show the homeowner’s set’s photos: only a photo of the signed record, never another job’s or company’s', async () => {
    const { jobId, issued, photoId, photoBytes, record } = await signedJob();
    expect(record.documents.photo_log.map((row: { id: string }) => row.id)).toEqual([photoId]);
    const shown = await photoOf(issued.homeowner.token, photoId);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(photoBytes);
    // Another job of the same company, with its own photo.
    const other = await l.f.readyJob(ESTIMATOR_A, h.seed.a);
    // A photo of company B.
    const elsewhere = await l.f.readyJob(OWNER_B, h.seed.b);
    // The record's signature is not a photo of the log.
    for (const id of [other.photoId, elsewhere.photoId, record.signature.id, randomUUID()]) {
      expect(await json(photoOf(issued.homeowner.token, id))).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    }
    expect((await photoOf(issued.homeowner.token, 'not-an-id')).status).toBe(404);
    await revoke(OFFICE_A, jobId, issued.homeowner.link.id);
    expect((await photoOf(issued.homeowner.token, photoId)).status).toBe(404);
  });

  it('are revocable by the owner or office, not the estimator; a revoked link is unavailable', async () => {
    const { jobId, issued } = await signedJob();
    expect(await revoke(ESTIMATOR_A, jobId, issued.homeowner.link.id)).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await revoke(OWNER_B, jobId, issued.homeowner.link.id)).toMatchObject({ status: 404 });
    expect(await revoke(OFFICE_A, jobId, issued.homeowner.link.id)).toMatchObject({ status: 200, body: { link: { id: issued.homeowner.link.id, status: 'revoked' } } });
    expect(await open(issued.homeowner.token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await signatureOf(issued.homeowner.token)).status).toBe(404);
    expect(await revoke(OWNER_A, jobId, issued.adjuster.link.id)).toMatchObject({ status: 200, body: { link: { status: 'revoked' } } });
    expect(await revoke(OWNER_A, jobId, issued.adjuster.link.id)).toMatchObject({ status: 200, body: { link: { status: 'revoked' } } });
    expect(await revoke(OWNER_A, jobId, randomUUID())).toMatchObject({ status: 404 });
    expect(await l.f.auditActions(jobId)).toEqual(expect.arrayContaining(['document_link_created', 'document_link_revoked']));
  });

  it('are made again for a signed job only; the owner or office replaces a working one, and making a link never revokes one for someone who may not', async () => {
    const unsigned = await l.pricedJob();
    expect(await make(ESTIMATOR_A, unsigned.jobId, { id: randomUUID(), set: 'homeowner' })).toMatchObject({ status: 409, body: { error: 'not_signed' } });
    const { jobId, issued } = await signedJob();
    expect(await make(OWNER_B, jobId, { id: randomUUID(), set: 'homeowner' })).toMatchObject({ status: 404 });
    expect(await make(ESTIMATOR_A, jobId, { id: randomUUID(), set: 'everything' })).toMatchObject({ status: 400 });
    // The estimator may not replace the working homeowner link made at signing.
    expect(await make(ESTIMATOR_A, jobId, { id: randomUUID(), set: 'homeowner' })).toMatchObject({ status: 409, body: { error: 'link_active' } });
    expect((await open(issued.homeowner.token)).status).toBe(200);
    // The owner may: the older link stops working.
    const owners = await documentLink(OWNER_A, jobId, 'homeowner');
    expect((await open(issued.homeowner.token)).status).toBe(404);
    expect((await open(owners.token)).status).toBe(200);
    // Nor may the estimator replace the owner's.
    expect(await make(ESTIMATOR_A, jobId, { id: randomUUID(), set: 'homeowner' })).toMatchObject({ status: 409, body: { error: 'link_active' } });
    expect((await open(owners.token)).status).toBe(200);
    // Office, who may revoke but not sign, revokes the adjuster's link and makes it again; it works.
    expect((await revoke(OFFICE_A, jobId, issued.adjuster.link.id)).status).toBe(200);
    const offices = await documentLink(OFFICE_A, jobId, 'adjuster');
    expect((await open(offices.token)).body.set).toBe('adjuster');
    // Once a set has no working link, whoever may sign makes one.
    expect((await revoke(OWNER_A, jobId, owners.id)).status).toBe(200);
    const estimators = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    expect((await open(estimators.token)).status).toBe(200);
    expect(await make(ESTIMATOR_A, jobId, { id: estimators.id, set: 'adjuster' })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await make(ESTIMATOR_A, jobId, { id: owners.id, set: 'homeowner' })).toMatchObject({ status: 409, body: { error: 'link_ended' } });
    expect((await revoke(OWNER_A, jobId, estimators.id)).status).toBe(200);
    expect(await make(ESTIMATOR_A, jobId, { id: estimators.id, set: 'homeowner' })).toMatchObject({ status: 409, body: { error: 'link_ended' } });
  });

  it('a retried create answers a new token to the owner or office only, never to its maker without the revoke right', async () => {
    const { jobId, issued } = await signedJob();
    const owners = await documentLink(OWNER_A, jobId, 'homeowner');
    // The estimator sending the owner's create again would replace the owner's token: refused.
    expect(await make(ESTIMATOR_A, jobId, { id: owners.id, set: 'homeowner' })).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect((await open(owners.token)).status).toBe(200);
    const again = await make(OWNER_A, jobId, { id: owners.id, set: 'homeowner' });
    expect(again.status).toBe(200);
    expect((await open(owners.token)).status).toBe(404);
    expect((await open(again.body.token)).status).toBe(200);
    expect((await revoke(OWNER_A, jobId, issued.adjuster.link.id)).status).toBe(200);
    const estimators = await documentLink(ESTIMATOR_A, jobId, 'adjuster');
    // The estimator's own create again would revoke a token they may already have shared: refused.
    expect(await make(ESTIMATOR_A, jobId, { id: estimators.id, set: 'adjuster' })).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect((await open(estimators.token)).status).toBe(200);
    // Office may replace it.
    const offices = await make(OFFICE_A, jobId, { id: estimators.id, set: 'adjuster' });
    expect(offices.status).toBe(200);
    expect((await open(estimators.token)).status).toBe(404);
    expect((await open(offices.body.token)).status).toBe(200);
  });

  it('are unavailable after 30 days, then whoever may sign makes one again; and once their maker can no longer act for the job', async () => {
    const { jobId, issued } = await signedJob();
    await l.age('document_links', issued.homeowner.link.id, 30);
    expect(await open(issued.homeowner.token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await list(OWNER_A, jobId)).body.links.find((link: { id: string }) => link.id === issued.homeowner.link.id)).toMatchObject({ status: 'expired' });
    const fresh = await documentLink(ESTIMATOR_A, jobId, 'homeowner');
    expect((await open(fresh.token)).status).toBe(200);
    // A maker who moves to office still holds delivery_resend: their links keep working.
    await h.admin`UPDATE memberships SET role = 'office' WHERE id = ${h.seed.estimatorA.membership}`;
    expect((await open(fresh.token)).status).toBe(200);
    await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.estimatorA.membership}`;
    expect(await open(fresh.token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect(await open(issued.adjuster.token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
  });

  it('a document link of company A opens nothing of company B and is no sign-in anywhere', async () => {
    const { jobId, issued } = await signedJob();
    const { token } = issued.homeowner;
    const asBearer = request(null, `/api/jobs/${jobId}/document-links`);
    asBearer.headers.set('Authorization', `Bearer ${token}`);
    expect((await documentLinksRoute.GET(asBearer, params({ jobId }))).status).toBe(401);
    // A signing-link route does not take a document link's token, nor the other way round.
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    const page = JSON.stringify((await open(token)).body);
    expect(page).not.toContain(h.seed.b);
  });

  it('a used signing link’s token opens no document set', async () => {
    const { token, photoId } = await signedJob();
    expect(await open(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await signatureOf(token)).status).toBe(404);
    expect((await photoOf(token, photoId)).status).toBe(404);
  });
});
