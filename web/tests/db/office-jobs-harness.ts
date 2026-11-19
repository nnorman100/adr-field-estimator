import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import type { FakeClaims, Harness } from './team-harness';

// Shared setup of the office jobs tests (office-jobs-api.test.ts and office-jobs-field-owner.test.ts):
// the route files, the people, the request helpers and the per-test database. Each test file mocks the
// services (vi.mock is per file) and calls setUpOfficeJobsDatabase with its hoisted `live` holder.

export const jobsRoute = await import('@/app/api/jobs/route');
export const jobRoute = await import('@/app/api/jobs/[jobId]/route');
export const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
export const claimRoute = await import('@/app/api/jobs/[jobId]/claim/route');
export const archiveRoute = await import('@/app/api/jobs/[jobId]/archive/route');
export const restoreRoute = await import('@/app/api/jobs/[jobId]/restore/route');
export const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
export const coordinationRoute = await import('@/app/api/jobs/[jobId]/coordination/route');
export const assignmentsRoute = await import('@/app/api/jobs/[jobId]/assignments/route');
export const assignmentRoute = await import('@/app/api/jobs/[jobId]/assignments/[assignmentId]/route');
export const fieldOwnerRoute = await import('@/app/api/jobs/[jobId]/field-owner/route');
export const transferRoute = await import('@/app/api/jobs/[jobId]/field-owner/transfer/route');
export const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
export const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
export const workingCopyRoute = await import('@/app/api/prices/working-copy/route');
export const meRoute = await import('@/app/api/me/route');
export const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
export let h: Harness;

export const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
export const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
export const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
export const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
export const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };
export const ESTIMATOR_B: FakeClaims = { tenant: 'tenant-b', uid: 'estimator-b' };

export let estimatorA2: string;


export type Person = { actorId: string; displayName: string | null; email: string };
export type Body = {
  job: { id: string; status: string; currentDraftId: string; fieldOwnerActorId: string | null; revision: number };
  customer: { name: string };
  draftMissing?: true;
  jobs: { id: string; mine: boolean }[];
  jobId: string;
  revision: number;
  notes: string;
  fieldOwner: Person | null;
  assignments: (Person & { id: string; assignedAt: string })[];
  estimators: Person[];
  capabilities: string[];
  error: string;
};
export type Answer = { status: number; body: Body };

export async function answer(response: Response | Promise<Response>): Promise<Answer> {
  const done = await response;
  expect(done.headers.get('cache-control')).toBe('no-store');
  return { status: done.status, body: (await done.json()) as Body };
}

export const job = (jobId: string) => params({ jobId });
export const create = (claims: FakeClaims, body: unknown) => answer(jobsRoute.POST(request(claims, '/api/jobs', { method: 'POST', body }), params({})));
export const list = (claims: FakeClaims, query = '') => answer(jobsRoute.GET(request(claims, `/api/jobs${query}`), params({})));
export const read = (claims: FakeClaims, jobId: string) => answer(jobRoute.GET(request(claims, `/api/jobs/${jobId}`), job(jobId)));
export const saveCustomer = (claims: FakeClaims, jobId: string, revision: number) =>
  answer(
    customerRoute.PUT(
      request(claims, `/api/jobs/${jobId}/customer`, {
        method: 'PUT',
        body: { revision, changeId: randomUUID(), name: 'Pat Example', phone: '555-0100', email: 'pat@example.test', propertyAddress: '12 Sample Way' },
      }),
      job(jobId),
    ),
  );
export const saveClaim = (claims: FakeClaims, jobId: string, revision: number) =>
  answer(
    claimRoute.PUT(
      request(claims, `/api/jobs/${jobId}/claim`, {
        method: 'PUT',
        body: {
          revision,
          changeId: randomUUID(),
          carrier: 'Sample Mutual',
          claimNumber: 'CL-1',
          policyNumber: 'PO-1',
          dateOfLoss: '2026-10-30',
          lossCause: 'Burst supply line',
          adjusterName: 'Alex Adjuster',
          adjusterEmail: 'alex@example.test',
          adjusterPhone: '555-0111',
          deductible: '$1,000',
        },
      }),
      job(jobId),
    ),
  );
export const coordination = (claims: FakeClaims, jobId: string) => answer(coordinationRoute.GET(request(claims, `/api/jobs/${jobId}/coordination`), job(jobId)));
export const saveNotes = (claims: FakeClaims, jobId: string, body: unknown) =>
  answer(coordinationRoute.PUT(request(claims, `/api/jobs/${jobId}/coordination`, { method: 'PUT', body }), job(jobId)));
export const assign = (claims: FakeClaims, jobId: string, estimatorActorId: string, id = randomUUID()) =>
  answer(assignmentsRoute.POST(request(claims, `/api/jobs/${jobId}/assignments`, { method: 'POST', body: { id, estimatorActorId } }), job(jobId)));
export const unassign = (claims: FakeClaims, jobId: string, assignmentId: string) =>
  answer(
    assignmentRoute.DELETE(request(claims, `/api/jobs/${jobId}/assignments/${assignmentId}`, { method: 'DELETE' }), params({ jobId, assignmentId })),
  );
export const archive = (claims: FakeClaims, jobId: string, body: unknown) =>
  answer(archiveRoute.POST(request(claims, `/api/jobs/${jobId}/archive`, { method: 'POST', body }), job(jobId)));
export const restore = (claims: FakeClaims, jobId: string, body: unknown) =>
  answer(restoreRoute.POST(request(claims, `/api/jobs/${jobId}/restore`, { method: 'POST', body }), job(jobId)));
export const claim = (claims: FakeClaims, jobId: string) => answer(fieldOwnerRoute.POST(request(claims, `/api/jobs/${jobId}/field-owner`, { method: 'POST' }), job(jobId)));
export const transfer = (claims: FakeClaims, jobId: string, body: unknown) =>
  answer(transferRoute.POST(request(claims, `/api/jobs/${jobId}/field-owner/transfer`, { method: 'POST', body }), job(jobId)));
export const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const sendPhoto = (claims: FakeClaims, jobId: string, photoId = randomUUID()) =>
  answer(
    photoRoute.PUT(
      request(claims, `/api/jobs/${jobId}/photos/${photoId}?kind=photo`, { method: 'PUT', body: Uint8Array.from([...PNG, ...Buffer.from(`synthetic ${photoId}`)]) }),
      params({ jobId, photoId }),
    ),
  );
export const submit = (claims: FakeClaims, jobId: string, draftId: string) =>
  answer(
    submissionsRoute.POST(
      request(claims, `/api/jobs/${jobId}/submissions`, { method: 'POST', body: { id: randomUUID(), draftId, digest: '0'.repeat(64) } }),
      job(jobId),
    ),
  );

// Field work the server can record: one named room, no photos and no price ids.
export const MANIFEST = { draft: { roomOrder: ['kitchen'] }, rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }], photos: [] };
export const submitDraft = (claims: FakeClaims, jobId: string, body: { id: string; draftId: string; digest: string }) =>
  answer(submissionsRoute.POST(request(claims, `/api/jobs/${jobId}/submissions`, { method: 'POST', body }), job(jobId)));
export const nextDraft = (claims: FakeClaims, jobId: string, body: { draftId: string; fromDraftId: string }) =>
  answer(draftsRoute.POST(request(claims, `/api/jobs/${jobId}/drafts`, { method: 'POST', body }), job(jobId)));

export const count = async (table: string, where = 'true') => Number((await h.admin.unsafe(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]!.n);
export const audits = (action: string) => count('audit_events', `action = '${action}'`);
// Company A's draft in the field-draft stand-in.
export const draftOf = (draftId: string) => h.drafts.made.get(`${h.seed.a}/${draftId}`);

// An office user starts a job: the empty scope only, and nobody owns its field work yet.
export async function officeJob(): Promise<{ id: string; draftId: string }> {
  const ids = { id: randomUUID(), draftId: randomUUID() };
  const made = await create(OFFICE_A, { ...ids, propertyAddress: '40 Office Road' });
  expect(made.status).toBe(201);
  return ids;
}

export function setUpOfficeJobsDatabase(live: { harness: Harness | null }): void {
  beforeAll(async () => {
    base = await startTeamServer();
  });

  beforeEach(async () => {
    h = await resetTeamDatabase(base, live.harness);
    live.harness = h;
    // A second active estimator in company A: the one who is refused once the first owns the field work.
    const [actor] = await h.admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${h.seed.a}, 'tenant-a', 'estimator-a2', 'estimator-a2@example.test') RETURNING id
    `;
    await h.admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${h.seed.a}, ${actor!.id}, 'estimator')`;
    estimatorA2 = actor!.id;
  });

  afterAll(async () => {
    await live.harness?.handle.close();
    await base?.admin.end({ timeout: 5 });
    await base?.server.stop();
  });
}
