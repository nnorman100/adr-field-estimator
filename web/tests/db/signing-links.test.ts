import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { image, json, sha256 } from './submission-flow';
import { AUTHORIZATION, ESTIMATOR_A, linkFlow, OFFICE_A, OWNER_A, OWNER_B, PAYMENT_TERMS, type Body } from './link-flow';
import type { Harness } from './team-harness';

// S5a-11b, homeowner signing links (docs/plans/S5.md; docs/spec.md 2.5 and 4.2), through the real
// route files as the runtime role against Postgres. The technician makes the link from the job's
// priced estimate; the homeowner's calls carry only the token, in the X-Link-Token header.
const live = vi.hoisted(() => ({ harness: null as Harness | null, linksDb: null as Harness['handle']['db'] | null }));
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
    signingLinksServices: () => signingLinksService(live.linksDb ?? live.harness!.handle.db, live.harness!.photos),
    documentLinksServices: () => documentLinksService(live.harness!.handle.db, live.harness!.photos),
  };
});

const jobsRoute = await import('@/app/api/jobs/route');
const jobRoute = await import('@/app/api/jobs/[jobId]/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const agreementsRoute = await import('@/app/api/jobs/[jobId]/agreements/route');
const signingLinkRoute = await import('@/app/api/jobs/[jobId]/signing-link/route');
const coordinationRoute = await import('@/app/api/jobs/[jobId]/coordination/route');
const transferRoute = await import('@/app/api/jobs/[jobId]/field-owner/transfer/route');
const signRoute = await import('@/app/api/sign/route');
const signatureRoute = await import('@/app/api/sign/signature/[signatureId]/route');
const signedSignatureRoute = await import('@/app/api/sign/signature/route');
const signPhotoRoute = await import('@/app/api/sign/photos/[photoId]/route');
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
  live.linksDb = null;
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  await l.setUp();
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const signedImage = async (token: string) => signedSignatureRoute.GET(l.linkRequest(token, '/api/sign/signature'), params({}));
const photo = (token: string | null, photoId: string) => signPhotoRoute.GET(l.linkRequest(token, `/api/sign/photos/${photoId}`), params({ photoId }));
// Everything stored about links and their audit rows, as text, to search for a token.
const storedText = async () =>
  JSON.stringify([
    await h.admin`SELECT * FROM signing_links`,
    await h.admin`SELECT * FROM document_links`,
    await h.admin`SELECT * FROM audit_events`,
    await h.admin`SELECT id, request_digest, encode(documents_bytes, 'escape') AS bytes FROM agreements`,
  ]);

describe('making a signing link', () => {
  it('answers the token once and stores only its SHA-256; the technician sees the link, never the token', async () => {
    const { jobId, token, linkId, link, estimate } = await l.linkedJob();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({ id: linkId, estimateId: estimate.id, status: 'pending' });
    // Seven days from when it was made, by the database's clock.
    expect(Date.parse(link.expiresAt) - Date.parse(link.createdAt)).toBe(7 * 86_400_000);
    const [row] = await l.linkRows(jobId);
    expect(row).toMatchObject({ id: linkId, status: 'pending', token_sha256: createHash('sha256').update(token).digest('hex') });
    expect(await storedText()).not.toContain(token);
    const status = await l.linkStatus(ESTIMATOR_A, jobId);
    expect(status).toMatchObject({ status: 200, body: { link: { id: linkId, status: 'pending' } } });
    expect(JSON.stringify(status.body)).not.toContain(token);
    expect(await l.f.auditActions(jobId)).toContain('signing_link_created');
  });

  it('is made only by someone who may sign, for the job’s current, signable estimate', async () => {
    const { jobId, estimate } = await l.pricedJob();
    expect(await l.makeLink(OFFICE_A, jobId, l.linkBody(estimate))).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await l.makeLink(OWNER_B, jobId, l.linkBody(estimate))).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await l.makeLink(ESTIMATOR_A, jobId, { ...l.linkBody(estimate), estimateId: randomUUID() })).toMatchObject({ status: 409, body: { error: 'estimate_superseded' } });
    expect(await l.makeLink(ESTIMATOR_A, jobId, { ...l.linkBody(estimate), proposalSha256: '0'.repeat(64) })).toMatchObject({ status: 409, body: { error: 'proposal_changed' } });
    expect(await l.makeLink(ESTIMATOR_A, jobId, { ...l.linkBody(estimate), token: 'x' })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await l.linkRows(jobId)).toEqual([]);
    // The owner may make one for an estimator's job.
    expect((await l.makeLink(OWNER_A, jobId, l.linkBody(estimate))).status).toBe(201);
  });

  it('a retried create with the same link id voids the unseen token and returns a new one', async () => {
    const { jobId, token, body } = await l.linkedJob();
    const again = await l.makeLink(ESTIMATOR_A, jobId, body);
    expect(again).toMatchObject({ status: 200, body: { link: { id: body.id, status: 'pending' } } });
    const second = again.body.token as string;
    expect(second).not.toBe(token);
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await l.view(second)).status).toBe(200);
    expect(await l.linkRows(jobId)).toHaveLength(1);
    // The same id with another body, or for another job, is refused.
    const other = await l.pricedJob();
    expect(await l.makeLink(ESTIMATOR_A, other.jobId, { ...body, estimateId: other.estimate.id, proposalSha256: other.estimate.proposalSha256 })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  });

  it('keeps one pending link per job: a newer link revokes the older one', async () => {
    const { jobId, token, estimate, linkId } = await l.linkedJob();
    const newer = await l.makeLink(ESTIMATOR_A, jobId, l.linkBody(estimate));
    expect(newer.status).toBe(201);
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await l.view(newer.body.token)).status).toBe(200);
    const rows = await l.linkRows(jobId);
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [linkId, 'revoked'],
      [newer.body.link.id, 'pending'],
    ]);
    expect(rows[0]!.ended_by_actor_id).toBe(h.seed.estimatorA.actor);
    // The older link's id cannot be brought back by sending its create again.
    expect(await l.makeLink(ESTIMATOR_A, jobId, { id: linkId, estimateId: estimate.id, proposalSha256: estimate.proposalSha256 })).toMatchObject({ status: 409, body: { error: 'link_ended' } });
  });

  it('shows the link made last as the job’s link, even when its create started before another and waited', async () => {
    const { jobId, estimate } = await l.pricedJob();
    // The first create runs on a connection of its own, as on another server instance.
    const { openDatabase } = await import('@/db/client');
    const instance = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl });
    const db = instance.db;
    try {
      let begun!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (begun = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      // The first create's transaction starts, then waits before it reaches the job, while a second create runs to the end.
      live.linksDb = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'transaction') return Reflect.get(target, key, receiver);
          return (run: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              await tx.execute(sql`SELECT 1`);
              begun();
              await held;
              return run(tx);
            });
        },
      });
      const first = l.linkBody(estimate);
      const waiting = l.makeLink(ESTIMATOR_A, jobId, first);
      await started;
      live.linksDb = null;
      const second = await l.makeLink(ESTIMATOR_A, jobId, l.linkBody(estimate));
      expect(second.status).toBe(201);
      release();
      const made = await waiting;
      expect(made.status).toBe(201);
      expect(await l.view(made.body.token)).toMatchObject({ status: 200, body: { status: 'pending' } });
      expect(await l.view(second.body.token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
      expect(await l.linkStatus(ESTIMATOR_A, jobId)).toMatchObject({ status: 200, body: { link: { id: first.id, status: 'pending' } } });
      expect(await l.revokeLink(ESTIMATOR_A, jobId)).toMatchObject({ status: 200, body: { link: { id: first.id, status: 'revoked' } } });
    } finally {
      await instance.close();
    }
  });

  it('is revoked by the technician, after which the homeowner sees the unavailable answer', async () => {
    const { jobId, token, linkId } = await l.linkedJob();
    expect(await l.revokeLink(ESTIMATOR_A, jobId)).toMatchObject({ status: 200, body: { link: { id: linkId, status: 'revoked' } } });
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect(await l.sendSignature(token, randomUUID(), image('revoked'))).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect(await l.signWith(token, l.signBody(randomUUID()))).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect(await l.agreementRows(jobId)).toEqual([]);
    expect(await l.revokeLink(ESTIMATOR_A, jobId)).toMatchObject({ status: 200, body: { link: { id: linkId, status: 'revoked' } } });
    expect(await l.revokeLink(OFFICE_A, jobId)).toMatchObject({ status: 403 });
    expect(await l.f.auditActions(jobId)).toContain('signing_link_revoked');
  });
});

describe('the homeowner’s page', () => {
  it('shows the documents of the estimate the link signs, with the company’s terms exactly as entered and no staff notes', async () => {
    const { token, estimate } = await l.linkedJob();
    const page = await l.view(token);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ status: 'pending', estimate: { id: estimate.id, proposalSha256: estimate.proposalSha256 } });
    expect(page.body.companyName).toBeTypeOf('string');
    expect(page.body.estimate.proposal).toEqual(estimate.proposal);
    expect(page.body.estimate.proposal.authorization_text).toBe(AUTHORIZATION);
    expect(page.body.estimate.proposal.payment_terms_text).toBe(PAYMENT_TERMS);
    expect(Object.keys(page.body.estimate.documents).sort()).toEqual(['claim', 'compliance_notes', 'itemized_claim', 'letter', 'photo_log']);
    // Nothing the company keeps for itself: the written summary, the engine's checks, the lines.
    const text = JSON.stringify(page.body);
    for (const kept of ['staffNotes', 'Category 2 water in two rooms.', 'quantity_notes', 'warnings', 'lines', 'priced_result', 'pricedResult']) expect(text).not.toContain(kept);
    expect(page.body.estimate.documents.letter).toBe(estimate.documents.letter);
  });

  it('answers a missing, malformed or unknown token the same unavailable way', async () => {
    await l.linkedJob();
    for (const token of [null, 'short', 'A'.repeat(43)]) expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
  });

  it('shows each photo of the record on request: only a photo of the link’s submitted record, never another job’s or company’s', async () => {
    const { token, photoId, photoBytes } = await l.linkedJob();
    const page = await l.view(token);
    expect(page.body.estimate.documents.photo_log.map((row: { id: string }) => row.id)).toEqual([photoId]);
    const shown = await photo(token, photoId);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('cache-control')).toBe('no-store');
    expect(shown.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(photoBytes);
    // A photo of another job of the same company, one of company B, and an id nobody holds.
    const other = await l.f.readyJob(ESTIMATOR_A, h.seed.a);
    const elsewhere = await l.f.readyJob(OWNER_B, h.seed.b);
    for (const id of [other.photoId, elsewhere.photoId, randomUUID()]) {
      expect(await json(photo(token, id))).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    }
    expect((await photo(null, photoId)).status).toBe(404);
    // After signing, while the signed record is shown.
    expect((await l.homeownerSigns(token)).answer.status).toBe(201);
    expect((await photo(token, photoId)).status).toBe(200);
    expect((await photo(token, other.photoId)).status).toBe(404);
    // A revoked link shows none.
    const revoked = await l.linkedJob();
    expect((await l.revokeLink(ESTIMATOR_A, revoked.jobId)).status).toBe(200);
    expect((await photo(revoked.token, revoked.photoId)).status).toBe(404);
  });

  it('is unavailable after seven days', async () => {
    const { token, linkId } = await l.linkedJob();
    await l.age('signing_links', linkId, 7);
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect(await l.sendSignature(token, randomUUID(), image('late'))).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect(await l.signWith(token, l.signBody(randomUUID()))).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
  });
});

describe('signing through a link', () => {
  it('signs once, as the technician who made the link, and the locked record names the link', async () => {
    const { jobId, token, linkId, estimate } = await l.linkedJob();
    const { answer, signatureId, bytes } = await l.homeownerSigns(token);
    expect(answer.status).toBe(201);
    const [row] = await l.agreementRows(jobId);
    expect(row).toMatchObject({
      signer_kind: 'link',
      signer_name: 'Casey Customer',
      signer_role: 'homeowner',
      signing_link_id: linkId,
      created_by_actor_id: h.seed.estimatorA.actor,
      estimate_id: estimate.id,
    });
    const record = answer.body.agreement.record;
    expect(record.signer).toEqual({ name: 'Casey Customer', role: 'homeowner' });
    expect(record.signed_with).toEqual({ kind: 'link', link_id: linkId });
    expect(record.signature).toEqual({ id: signatureId, sha256: sha256(bytes), content_type: 'image/png' });
    expect(record.proposal.authorization_text).toBe(AUTHORIZATION);
    expect(JSON.parse(row!.documents_bytes.toString('utf8'))).toEqual(record);
    expect((await l.f.job(jobId)).status).toBe('signed');
    const [link] = await l.linkRows(jobId);
    expect(link).toMatchObject({ status: 'used', agreement_id: row!.id });
    expect(await l.linkStatus(ESTIMATOR_A, jobId)).toMatchObject({ body: { link: { status: 'used' } } });
    // The job's own signed page, read by office, is the same record.
    const read = (await json(agreementsRoute.GET(request(OFFICE_A, `/api/jobs/${jobId}/agreements`), params({ jobId })))) as { body: Body };
    expect(read.body.agreement.record).toEqual(record);
    const audit = await h.admin<{ actor_id: string; details: Body }[]>`SELECT actor_id::text, details FROM audit_events WHERE target = ${jobId} AND action = 'agreement_signed'`;
    expect(audit).toEqual([{ actor_id: h.seed.estimatorA.actor, details: expect.objectContaining({ signingLink: linkId }) }]);
    expect(await storedText()).not.toContain(token);
  });

  it('asks who signs: a request without a role, or with one the page does not offer, is refused', async () => {
    const { jobId, token } = await l.linkedJob();
    const signatureId = randomUUID();
    expect((await l.sendSignature(token, signatureId, image('role'))).status).toBe(201);
    const without = { id: randomUUID(), signatureId, signerName: 'Casey Customer', documentsConfirmed: true, electronicConsent: true };
    expect(await l.signWith(token, without)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await l.signWith(token, l.signBody(signatureId, { signerRole: 'landlord' }))).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await l.agreementRows(jobId)).toEqual([]);
    const adjuster = await l.signWith(token, l.signBody(signatureId, { signerRole: 'adjuster' }));
    expect(adjuster.status).toBe(201);
    expect(adjuster.body.agreement.record.signer).toEqual({ name: 'Casey Customer', role: 'adjuster' });
    expect((await l.agreementRows(jobId))[0]!.signer_role).toBe('adjuster');
  });

  it('the same request sent twice returns the same receipt; a changed one with the same id is refused', async () => {
    const { jobId, token } = await l.linkedJob();
    const { answer, body } = await l.homeownerSigns(token);
    expect(answer.status).toBe(201);
    const again = await l.signWith(token, body);
    expect(again.status).toBe(200);
    expect(again.body.agreement).toEqual(answer.body.agreement);
    expect(await l.signWith(token, { ...body, signerName: 'Someone Else' })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await l.signWith(token, { ...body, id: randomUUID() })).toMatchObject({ status: 409, body: { error: 'already_signed' } });
    expect(await l.agreementRows(jobId)).toHaveLength(1);
  });

  it('a token replaced while its signing request waits signs nothing; the new token signs', async () => {
    const { jobId, token, body } = await l.linkedJob();
    const signatureId = randomUUID();
    expect((await l.sendSignature(token, signatureId, image('raced'))).status).toBe(201);
    // The sign request runs on a connection of its own, as on another server instance, and waits at
    // the start of its signing transaction (its fifth: two lookups, two counters, then signing).
    const { openDatabase } = await import('@/db/client');
    const instance = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl });
    try {
      let begun!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (begun = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      live.linksDb = new Proxy(instance.db, {
        get(target, key, receiver) {
          if (key !== 'transaction') return Reflect.get(target, key, receiver);
          return (run: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
            calls += 1;
            if (calls !== 5) return (target.transaction as (...args: unknown[]) => Promise<unknown>)(run, ...rest);
            return target.transaction(async (tx) => {
              await tx.execute(sql`SELECT 1`);
              begun();
              await held;
              return run(tx);
            });
          };
        },
      });
      const waiting = l.signWith(token, l.signBody(signatureId));
      await started;
      live.linksDb = null;
      // The technician's create sent again: the token is replaced.
      const again = await l.makeLink(ESTIMATOR_A, jobId, body);
      expect(again.status).toBe(200);
      release();
      expect(await waiting).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
      expect(await l.agreementRows(jobId)).toEqual([]);
      expect((await l.signWith(again.body.token, l.signBody(signatureId))).status).toBe(201);
    } finally {
      live.linksDb = null;
      await instance.close();
    }
  });

  it('two simultaneous homeowner signatures give one agreement', async () => {
    const { jobId, token } = await l.linkedJob();
    const first = { id: randomUUID(), bytes: image('first') };
    const second = { id: randomUUID(), bytes: image('second') };
    expect((await l.sendSignature(token, first.id, first.bytes)).status).toBe(201);
    expect((await l.sendSignature(token, second.id, second.bytes)).status).toBe(201);
    const answers = await Promise.all([l.signWith(token, l.signBody(first.id)), l.signWith(token, l.signBody(second.id, { signerName: 'Robin Customer' }))]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    expect(answers.find((answer) => answer.status === 409)!.body.error).toBe('already_signed');
    expect(await l.agreementRows(jobId)).toHaveLength(1);
  });

  it('a link and the technician’s phone signing at once give one agreement', async () => {
    const { jobId, token, estimate } = await l.linkedJob();
    const onPhone = randomUUID();
    const sent = await json(photoRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/photos/${onPhone}?kind=signature`, { method: 'PUT', body: image('phone') }), params({ jobId, photoId: onPhone })));
    expect(sent.status).toBe(201);
    const viaLink = randomUUID();
    expect((await l.sendSignature(token, viaLink, image('link'))).status).toBe(201);
    const phoneBody = { id: randomUUID(), estimateId: estimate.id, proposalSha256: estimate.proposalSha256, signatureId: onPhone, signerName: 'Casey Customer', documentsConfirmed: true };
    const answers = await Promise.all([
      json(agreementsRoute.POST(request(ESTIMATOR_A, `/api/jobs/${jobId}/agreements`, { method: 'POST', body: phoneBody }), params({ jobId }))),
      l.signWith(token, l.signBody(viaLink)),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    expect(await l.agreementRows(jobId)).toHaveLength(1);
  });

  it('shows the signed record and signature read-only for 30 days after signing, then the unavailable answer', async () => {
    const { jobId, token, linkId } = await l.linkedJob();
    const { answer, bytes } = await l.homeownerSigns(token);
    const page = await l.view(token);
    expect(page).toMatchObject({ status: 200, body: { status: 'signed', agreement: { id: answer.body.agreement.id } } });
    expect(page.body.agreement.record).toEqual(answer.body.agreement.record);
    expect(Date.parse(page.body.viewUntil) - Date.parse(page.body.agreement.signedAt)).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
    const shown = await signedImage(token);
    expect(shown.status).toBe(200);
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(bytes);
    // A new signature is refused once signed.
    expect(await l.sendSignature(token, randomUUID(), image('late'))).toMatchObject({ status: 409, body: { error: 'already_signed' } });
    await l.age('signing_links', linkId, 30);
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    expect((await signedImage(token)).status).toBe(404);
    // The job's own record is unchanged.
    expect(await l.agreementRows(jobId)).toHaveLength(1);
  });
});

describe('voiding', () => {
  it('office notes and a move of the field work void neither the reviewed estimate nor its link (S5b-1)', async () => {
    const { jobId, token, linkId } = await l.linkedJob();
    const before = await l.f.job(jobId);
    const notes = await json(
      coordinationRoute.PUT(
        request(OFFICE_A, `/api/jobs/${jobId}/coordination`, { method: 'PUT', body: { revision: 0, changeId: randomUUID(), notes: 'Gate code 1234' } }),
        params({ jobId }),
      ),
    );
    expect(notes.status).toBe(200);
    const moved = await json(
      transferRoute.POST(
        request(OWNER_A, `/api/jobs/${jobId}/field-owner/transfer`, {
          method: 'POST',
          body: { revision: 1, changeId: randomUUID(), toActorId: h.seed.ownerA.actor },
        }),
        params({ jobId }),
      ),
    );
    expect(moved.status).toBe(200);
    expect((await l.f.job(jobId)).revision).toBe(before.revision);
    expect((await l.view(token)).status).toBe(200);
    expect((await l.linkRows(jobId))[0]).toMatchObject({ id: linkId, status: 'pending' });
    // Still reviewed: the homeowner signs through the same link.
    expect((await l.homeownerSigns(token)).answer.status).toBe(201);
    expect(await l.agreementRows(jobId)).toHaveLength(1);
  });

  it('a new submission voids the link: the page says the estimate changed and nothing can be signed', async () => {
    const { jobId, draftId, token, linkId } = await l.linkedJob();
    const signatureId = randomUUID();
    expect((await l.sendSignature(token, signatureId, image('before'))).status).toBe(201);
    expect((await l.f.nextDraft(ESTIMATOR_A, jobId, { draftId: randomUUID(), fromDraftId: draftId })).status).toBe(201);
    expect(await l.view(token)).toMatchObject({ status: 410, body: { error: 'link_voided' } });
    expect(await l.signWith(token, l.signBody(signatureId))).toMatchObject({ status: 410, body: { error: 'link_voided' } });
    expect((await l.linkRows(jobId))[0]).toMatchObject({ id: linkId, status: 'voided' });
    expect(await l.linkStatus(ESTIMATOR_A, jobId)).toMatchObject({ body: { link: { status: 'voided' } } });
    expect(await l.agreementRows(jobId)).toEqual([]);
  });

  it('a new estimate voids the link: a customer save after pricing, or a new record priced again', async () => {
    const { jobId, token } = await l.linkedJob();
    expect((await l.saveCustomer(ESTIMATOR_A, jobId, '12 Synthetic Lane, Testville', 'Casey Changed')).status).toBe(200);
    expect(await l.view(token)).toMatchObject({ status: 410, body: { error: 'link_voided' } });

    const next = await l.linkedJob();
    expect((await l.f.nextDraft(ESTIMATOR_A, next.jobId, { draftId: randomUUID(), fromDraftId: next.draftId })).status).toBe(201);
    const job = await l.f.job(next.jobId);
    h.field.put(h.seed.a, job.current_draft_id, next.manifest);
    expect((await l.f.submitShown(ESTIMATOR_A, next.jobId, job.current_draft_id, next.manifest)).answer.status).toBe(201);
    const priced = await l.price(ESTIMATOR_A, next.jobId);
    expect(priced.body.estimate.id).not.toBe(next.estimate.id);
    expect(await l.view(next.token)).toMatchObject({ status: 410, body: { error: 'link_voided' } });
    // A new link for the new estimate works.
    const fresh = await l.makeLink(ESTIMATOR_A, next.jobId, l.linkBody(priced.body.estimate));
    expect(fresh.status).toBe(201);
    expect((await l.view(fresh.body.token)).status).toBe(200);
  });

  it('a job signed on the phone voids its link', async () => {
    const { jobId, token, estimate } = await l.linkedJob();
    const onPhone = randomUUID();
    await photoRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/photos/${onPhone}?kind=signature`, { method: 'PUT', body: image('phone') }), params({ jobId, photoId: onPhone }));
    const body = { id: randomUUID(), estimateId: estimate.id, proposalSha256: estimate.proposalSha256, signatureId: onPhone, signerName: 'Casey Customer', documentsConfirmed: true };
    expect((await agreementsRoute.POST(request(ESTIMATOR_A, `/api/jobs/${jobId}/agreements`, { method: 'POST', body }), params({ jobId }))).status).toBe(201);
    expect(await l.view(token)).toMatchObject({ status: 410, body: { error: 'link_voided' } });
  });

  it('a company setting emptied after the link was made refuses signing for now and leaves the link as it is', async () => {
    const { jobId, token } = await l.linkedJob();
    await h.admin`UPDATE companies SET profile_documents = '{}'::jsonb WHERE id = ${h.seed.a}`;
    const signatureId = randomUUID();
    expect((await l.sendSignature(token, signatureId, image('wait'))).status).toBe(201);
    expect(await l.signWith(token, l.signBody(signatureId))).toMatchObject({ status: 409, body: { error: 'link_not_ready' } });
    expect((await l.linkRows(jobId))[0]!.status).toBe('pending');
    await h.admin`UPDATE companies SET profile_documents = ${JSON.stringify({ authorization_text: AUTHORIZATION, payment_terms_text: PAYMENT_TERMS })}::text::jsonb WHERE id = ${h.seed.a}`;
    expect((await l.signWith(token, l.signBody(signatureId))).status).toBe(201);
  });
});

describe('acting as the technician', () => {
  it('is unavailable once the technician is disabled or no longer holds sign, and again when they do', async () => {
    const { token } = await l.linkedJob();
    await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.estimatorA.membership}`;
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    await h.admin`UPDATE memberships SET status = 'active', role = 'office' WHERE id = ${h.seed.estimatorA.membership}`;
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    const signatureId = randomUUID();
    expect(await l.sendSignature(token, signatureId, image('office'))).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    await h.admin`UPDATE memberships SET role = 'estimator' WHERE id = ${h.seed.estimatorA.membership}`;
    expect((await l.view(token)).status).toBe(200);
  });

  it('is unavailable while the company’s prices are switched off or the company is suspended', async () => {
    const { token } = await l.linkedJob();
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
    await h.admin`UPDATE company_feature_flags SET enabled = true WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
    await h.admin`UPDATE companies SET status = 'suspended' WHERE id = ${h.seed.a}`;
    expect(await l.view(token)).toMatchObject({ status: 404, body: { error: 'link_unavailable' } });
  });
});

describe('limits', () => {
  it('allows ten signing attempts per link, each a signature and a sign request, then refuses', async () => {
    const { jobId, token } = await l.linkedJob();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await l.sendSignature(token, randomUUID(), image(`attempt ${attempt}`))).status).toBe(201);
      // Names a signature that never arrived, so the attempt is refused and the link stays pending.
      expect(await l.signWith(token, l.signBody(randomUUID()))).toMatchObject({ status: 409, body: { error: 'signature_missing' } });
    }
    expect(await l.sendSignature(token, randomUUID(), image('eleventh'))).toMatchObject({ status: 429, body: { error: 'too_many_attempts' } });
    expect(await l.signWith(token, l.signBody(randomUUID()))).toMatchObject({ status: 429, body: { error: 'too_many_attempts' } });
    expect(await l.agreementRows(jobId)).toEqual([]);
  });

  it('answers at most 60 requests a minute per link', async () => {
    const { token } = await l.linkedJob();
    for (let read = 0; read < 60; read += 1) expect((await l.view(token)).status).toBe(200);
    expect(await l.view(token)).toMatchObject({ status: 429, body: { error: 'too_many_requests' } });
  });

  it('takes a signature image of at most 1 MiB that is an image', async () => {
    const { token } = await l.linkedJob();
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(image('big'));
    expect(await l.sendSignature(token, randomUUID(), big)).toMatchObject({ status: 413, body: { error: 'too_large' } });
    expect(await l.sendSignature(token, randomUUID(), new TextEncoder().encode('not an image'))).toMatchObject({ status: 415, body: { error: 'unsupported_image' } });
  });
});

describe('companies', () => {
  it('a link of company A is useless for B’s routes, and B’s people cannot reach A’s link', async () => {
    const { jobId, token } = await l.linkedJob();
    // The token is never a sign-in: as a bearer token, or beside B's own sign-in, it opens nothing.
    const asBearer = request(null, `/api/jobs/${jobId}`);
    asBearer.headers.set('Authorization', `Bearer ${token}`);
    expect((await jobRoute.GET(asBearer, params({ jobId }))).status).toBe(401);
    const asHeader = l.linkRequest(token, `/api/jobs/${jobId}`);
    expect((await jobRoute.GET(asHeader, params({ jobId }))).status).toBe(401);
    const besideB = request(OWNER_B, `/api/jobs/${jobId}/signing-link`);
    besideB.headers.set('x-link-token', token);
    expect((await signingLinkRoute.GET(besideB, params({ jobId }))).status).toBe(404);
    expect((await l.revokeLink(OWNER_B, jobId)).status).toBe(404);
    expect((await l.view(token)).body.status).toBe('pending');
    // The page holds A's job only, never B's company or terms.
    await h.admin`UPDATE companies SET profile_documents = ${JSON.stringify({ authorization_text: 'Company B terms', payment_terms_text: 'Company B payment' })}::text::jsonb WHERE id = ${h.seed.b}`;
    const page = JSON.stringify((await l.view(token)).body);
    expect(page).not.toContain(h.seed.b);
    expect(page).not.toContain('Company B terms');
  });
});
