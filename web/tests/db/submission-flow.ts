import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import type { FakeClaims, Harness } from './team-harness';

// Shared by the Submit and Back to editing tests (S5a-8): a job made through the real jobs route,
// field data written as the phone writes it, a photo stored through the real photo route, and the
// calls and reads the tests make. See submissions-api.test.ts for the setup.

type Route = (request: Request, context: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;

export type Routes = {
  createJob: Route;
  putPhoto: Route;
  submit: Route;
  nextDraft: Route;
  request: (claims: FakeClaims | null, path: string, init?: { method?: string; body?: unknown }) => Request;
  params: (values: Record<string, string>) => { params: Promise<Record<string, string>> };
};

export type Answer = { status: number; body: Record<string, unknown> & { error?: string } };

export async function json(response: Response | Promise<Response>): Promise<Answer> {
  const done = await response;
  expect(done.headers.get('cache-control')).toBe('no-store');
  return { status: done.status, body: (await done.json()) as Answer['body'] };
}

// Bytes the photo route accepts as an image (a PNG's first bytes).
export const image = (seed: string): Uint8Array =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(`synthetic image ${seed}`)]);
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function flow(h: () => Harness, routes: Routes) {
  const { request, params } = routes;

  async function newJob(claims: FakeClaims): Promise<{ jobId: string; draftId: string }> {
    const ids = { jobId: randomUUID(), draftId: randomUUID() };
    const made = await routes.createJob(request(claims, '/api/jobs', { method: 'POST', body: { id: ids.jobId, draftId: ids.draftId } }), params({}));
    expect(made.status).toBe(201);
    return ids;
  }

  const sendPhoto = (claims: FakeClaims, jobId: string, photoId: string, bytes: Uint8Array) =>
    json(routes.putPhoto(request(claims, `/api/jobs/${jobId}/photos/${photoId}?kind=photo`, { method: 'PUT', body: bytes }), params({ jobId, photoId })));

  // A job with two rooms and one stored photo, as the phone leaves it before Finish and review.
  async function readyJob(claims: FakeClaims, company: string): Promise<{ jobId: string; draftId: string; photoId: string; photoBytes: Uint8Array; manifest: FieldManifest }> {
    const { jobId, draftId } = await newJob(claims);
    const photoId = randomUUID();
    const photoBytes = image(photoId);
    expect((await sendPhoto(claims, jobId, photoId, photoBytes)).status).toBe(201);
    const manifest: FieldManifest = {
      draft: { yearBuilt: 1972, roomOrder: ['kitchen', 'hall'], notes: 'Wet carpet by the sink.', summary: 'Category 2 water in two rooms.', airMovers: 3 },
      rooms: [
        { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
        { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40 } },
      ],
      photos: [{ id: photoId, field: { roomId: 'kitchen', shotTag: 'source' } }],
    };
    h().field.put(company, draftId, manifest);
    return { jobId, draftId, photoId, photoBytes, manifest };
  }

  const submit = (claims: FakeClaims | null, jobId: string, body: unknown) =>
    json(routes.submit(request(claims, `/api/jobs/${jobId}/submissions`, { method: 'POST', body }), params({ jobId })));

  // Submit as the phone sends it: a new id, the draft and the digest of what it shows.
  async function submitShown(claims: FakeClaims, jobId: string, draftId: string, manifest: FieldManifest, id = randomUUID()) {
    const body = { id, draftId, digest: await manifestDigest(manifest) };
    return { body, answer: await submit(claims, jobId, body) };
  }

  const nextDraft = (claims: FakeClaims | null, jobId: string, body: unknown) =>
    json(routes.nextDraft(request(claims, `/api/jobs/${jobId}/drafts`, { method: 'POST', body }), params({ jobId })));

  const submissions = (jobId: string) =>
    h().admin<{ id: string; draft_id: string; epoch: string; status: string; marker_state: string; snapshot: Buffer | null; snapshot_sha256: string | null }[]>`
      SELECT id::text, draft_id::text, epoch::text, status, marker_state, snapshot_bytes AS snapshot, snapshot_sha256
      FROM job_submissions WHERE job_id = ${jobId} ORDER BY created_at, id
    `;

  const job = async (jobId: string) =>
    (await h().admin<{ status: string; current_draft_id: string; revision: number; last_change_id: string | null }[]>`
      SELECT status, current_draft_id::text, revision, last_change_id::text FROM jobs WHERE id = ${jobId}
    `)[0]!;

  const auditActions = async (jobId: string) =>
    (await h().admin<{ action: string }[]>`SELECT action FROM audit_events WHERE target = ${jobId} ORDER BY id`).map((row) => row.action);

  // The one invariant of the handoff: a draft is `submitted` exactly when it has a committed
  // record, and otherwise back to `editing` once nothing is pending.
  async function expectOneOutcome(company: string, jobId: string, draftId: string): Promise<'committed' | 'aborted'> {
    const rows = (await submissions(jobId)).filter((row) => row.draft_id === draftId);
    expect(rows.filter((row) => row.status === 'pending')).toEqual([]);
    const committed = rows.filter((row) => row.status === 'committed');
    expect(committed.length).toBeLessThanOrEqual(1);
    const draft = h().field.draft(company, draftId);
    if (committed.length === 1) {
      expect(draft).toMatchObject({ state: 'submitted', fence: { submissionId: committed[0]!.id, epoch: committed[0]!.epoch } });
      expect((await job(jobId)).status).toBe('submitted');
      return 'committed';
    }
    expect(draft).toMatchObject({ state: 'editing', fence: null });
    expect((await job(jobId)).status).toBe('draft');
    return 'aborted';
  }

  return { newJob, sendPhoto, readyJob, submit, submitShown, nextDraft, submissions, job, auditActions, expectOneOutcome };
}

// A promise and the function that settles it, to hold one attempt at a gate.
export function latch(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

// Waits until `check` holds, for a call the test started but did not await.
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
