import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldManifest } from '@/lib/field/canonical';
import { flow, image, json, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5a-10, room inputs on Check Scope (docs/plans/S5.md; pricing plan S5a-3) through the real route
// files as the runtime role against Postgres: what Check Scope picks from (the job's room types and
// items from its pinned or current price version, the company's prep-task templates), Submit's
// check of a draft's room types and items against that version, and the two scenarios the plan
// adds: the same item in two rooms reaching the estimate as two lines, and a prep task picked from a
// template keeping its submitted words after the template is edited.
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
// Each test has its own database handle, so the lists service is built over the current one.
vi.mock('@/lib/scope-lists/services', async () => {
  const { scopeListsService } = await import('@/lib/scope-lists/service');
  return { scopeListsServices: () => scopeListsService(live.harness!.handle.db) };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const listsRoute = await import('@/app/api/jobs/[jobId]/scope-lists/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };

const f = flow(() => h, { createJob: jobsRoute.POST, putPhoto: photoRoute.PUT, submit: submissionsRoute.POST, nextDraft: draftsRoute.POST, request, params });

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', true)`;
  await h.admin`
    UPDATE companies SET profile_address = '1 Synthetic Way, Testville', profile_phone = '555-0100', profile_email = 'office@example.invalid',
      profile_license = '000001', profile_signoff = 'Pat Example'
    WHERE id = ${h.seed.a}
  `;
  const [actor] = await h.admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${h.seed.a}, 'tenant-a', 'estimator-a2', 'estimator-a2@example.test') RETURNING id
  `;
  await h.admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${h.seed.a}, ${actor!.id}, 'estimator')`;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

type Item = Record<string, unknown>;
const typedItem = (id: string, name: string, price: string, extra: Item = {}): Item => ({
  item_id: id,
  group: 'demolition',
  name,
  unit: 'lf',
  quantity_source: 'room:typed',
  unit_price: price,
  ...extra,
});

// Version 1: a 4 ft flood cut ($3.00 a foot, typed per room), a disabled typed item, an item priced
// from the room's areas, and one room type that suggests the flood cut.
const V1 = {
  items: [
    typedItem('flood_cut', '4 ft flood cut', '3.00', { sort_order: 2 }),
    typedItem('baseboard', 'Baseboard removal', '1.50', { enabled: false, sort_order: 1 }),
    { item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' },
  ],
  roomTypes: [{ id: 'bathroom', name: 'Bathroom', suggested_items: ['flood_cut', 'baseboard', 'extraction'] }],
};
// Version 2 adds a kitchen room type and toe-kick removal.
const V2 = {
  items: [...V1.items, typedItem('toe_kick', 'Toe-kick removal', '4.00')],
  roomTypes: [...V1.roomTypes, { id: 'kitchen', name: 'Kitchen', suggested_items: ['toe_kick'] }],
};

function tableOf(version: { items: Item[]; roomTypes: unknown[] }) {
  return {
    items: version.items,
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
      room_types: version.roomTypes,
    },
  };
}

// Publishes the company's next price version, as S4-6's publish stores it.
async function publish(version: { items: Item[]; roomTypes: unknown[] }): Promise<{ sequence: number }> {
  const table = parseTable(tableOf(version));
  const [row] = await h.admin<{ sequence: number }[]>`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    SELECT ${h.seed.a}, coalesce(max(sequence), 0) + 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(table)}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${h.seed.ownerA.actor}, ${`key-${randomUUID()}`}
    FROM price_table_versions WHERE company_id = ${h.seed.a}
    RETURNING sequence
  `;
  return row!;
}

// The owner's prep-task templates, as Company settings stores them (S5a-4b).
const setTemplates = (prepTasks: string[]) => h.admin`UPDATE companies SET profile_documents = ${JSON.stringify({ prep_tasks: prepTasks })}::text::jsonb WHERE id = ${h.seed.a}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const lists = (claims: FakeClaims | null, jobId: string): Promise<Answer & { body: Body }> =>
  json(listsRoute.GET(request(claims, `/api/jobs/${jobId}/scope-lists`), params({ jobId })));
const make = (claims: FakeClaims, jobId: string): Promise<Answer & { body: Body }> =>
  json(estimateRoute.POST(request(claims, `/api/jobs/${jobId}/estimate`, { method: 'POST' }), params({ jobId })));

// A job of company A with its property address saved and one stored photo, its draft still empty.
async function readyJob(claims: FakeClaims = ESTIMATOR_A) {
  const { jobId, draftId } = await f.newJob(claims);
  const photoId = randomUUID();
  expect((await f.sendPhoto(claims, jobId, photoId, image(photoId))).status).toBe(201);
  const ready = { jobId, draftId, photoId };
  const customer = { revision: (await f.job(ready.jobId)).revision, changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress: '12 Synthetic Lane, Testville' };
  expect((await customerRoute.PUT(request(claims, `/api/jobs/${ready.jobId}/customer`, { method: 'PUT', body: customer }), params({ jobId: ready.jobId }))).status).toBe(200);
  return ready;
}

// Field data as the phone writes it: the given rooms, in order, with the summary and the scope confirmed.
function manifestOf(photoId: string, rooms: Record<string, Record<string, unknown>>): FieldManifest {
  return {
    draft: { yearBuilt: 1990, roomOrder: Object.keys(rooms), summary: 'Category 1 water in two rooms.', scopeConfirmed: true },
    rooms: Object.entries(rooms).map(([id, field]) => ({ id, field })),
    photos: [{ id: photoId, field: { roomId: Object.keys(rooms)[0]!, shotTag: 'source' } }],
  };
}

async function submit(claims: FakeClaims, jobId: string, draftId: string, manifest: FieldManifest) {
  h.field.put(h.seed.a, draftId, manifest);
  return (await f.submitShown(claims, jobId, draftId, manifest)).answer;
}

describe('GET /api/jobs/{id}/scope-lists', () => {
  it('answers no version and empty lists before any prices are published, with the company’s templates', async () => {
    await setTemplates(['Move the contents out of the room.']);
    const { jobId } = await readyJob();
    const answer = await lists(ESTIMATOR_A, jobId);
    expect(answer).toMatchObject({ status: 200, body: { version: null, roomTypes: [], items: [], prepTasks: ['Move the contents out of the room.'] } });
  });

  it('lists room types and the enabled typed items by name and unit, and never a price', async () => {
    await publish(V1);
    const { jobId } = await readyJob();
    const answer = await lists(ESTIMATOR_A, jobId);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      version: 1,
      // The type's enabled suggestions, typed per room or priced from the room's measurements.
      roomTypes: [
        {
          id: 'bathroom',
          name: 'Bathroom',
          suggestedItems: [
            { itemId: 'flood_cut', name: '4 ft flood cut', unit: 'lf', typed: true, categories: [] },
            { itemId: 'extraction', name: 'Extraction', unit: 'sf', typed: false, categories: [] },
          ],
        },
      ],
      items: [{ itemId: 'flood_cut', name: '4 ft flood cut', unit: 'lf' }],
      prepTasks: [],
    });
    expect(JSON.stringify(answer.body)).not.toMatch(/3\.00|price/);
  });

  it('lists a room type’s suggestions priced from measurements when no item is typed per room', async () => {
    await publish({
      items: [
        { item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00', categories: [1, 2, 3] },
        { item_id: 'mold_clean', group: 'treatment', name: 'Mold cleaning', unit: 'sf', quantity_source: 'room:floor', unit_price: '4.00', categories: ['mold'] },
      ],
      roomTypes: [{ id: 'bathroom', name: 'Bathroom', suggested_items: ['extraction', 'mold_clean'] }],
    });
    const { jobId } = await readyJob();
    const answer = await lists(ESTIMATOR_A, jobId);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      items: [],
      roomTypes: [
        {
          id: 'bathroom',
          suggestedItems: [
            { itemId: 'extraction', name: 'Extraction', unit: 'sf', typed: false, categories: [1, 2, 3] },
            { itemId: 'mold_clean', name: 'Mold cleaning', unit: 'sf', typed: false, categories: ['mold'] },
          ],
        },
      ],
    });
    expect(JSON.stringify(answer.body)).not.toMatch(/2\.00|4\.00|price/);
  });

  it('answers everyone who can read the job, and no one else', async () => {
    await publish(V1);
    const { jobId } = await readyJob();
    expect((await lists(OWNER_A, jobId)).status).toBe(200);
    expect((await lists(OFFICE_A, jobId)).status).toBe(200);
    expect((await lists(ESTIMATOR_A2, jobId)).status).toBe(404);
    expect((await lists(OWNER_B, jobId)).status).toBe(404);
    expect((await lists(null, jobId)).status).toBe(401);
  });

  it('keeps answering the pinned version after a newer one is published', async () => {
    await publish(V1);
    const { jobId, draftId, photoId } = await readyJob();
    expect((await submit(ESTIMATOR_A, jobId, draftId, manifestOf(photoId, { hall: { name: 'Hall', category: 1, wetFloorSf: 10 } }))).status).toBe(201);
    expect((await make(ESTIMATOR_A, jobId)).status).toBe(201);
    await publish(V2);
    const answer = await lists(ESTIMATOR_A, jobId);
    expect(answer.body).toMatchObject({ version: 1, roomTypes: [{ id: 'bathroom' }], items: [{ itemId: 'flood_cut' }] });
    // A job with no pin gets the current version.
    const other = await readyJob();
    expect((await lists(ESTIMATOR_A, other.jobId)).body).toMatchObject({ version: 2, roomTypes: [{ id: 'bathroom' }, { id: 'kitchen' }] });
  });
});

describe('Submit checks room types and items against the job’s price version', () => {
  it('refuses a room type or item that is not in the current version, and releases the draft', async () => {
    await publish(V1);
    for (const room of [
      { name: 'Kitchen', roomTypeId: 'kitchen' },
      { name: 'Hall', items: { toe_kick: '2' } },
      // An item the version has but does not price by a room's typed quantity.
      { name: 'Hall', items: { extraction: '2' } },
    ]) {
      const { jobId, draftId, photoId } = await readyJob();
      const answer = await submit(ESTIMATOR_A, jobId, draftId, manifestOf(photoId, { r1: room }));
      expect({ room, answer }).toMatchObject({ room, answer: { status: 409, body: { error: 'unknown_price_ids' } } });
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
      expect(await f.auditActions(jobId)).toContain('submission_aborted');
    }
  });

  it('refuses any room type or item when no version is published, and passes a draft naming none', async () => {
    const plain = await readyJob();
    expect((await submit(ESTIMATOR_A, plain.jobId, plain.draftId, manifestOf(plain.photoId, { r1: { name: 'Hall', roomTypeId: 'other', category: 1 } }))).status).toBe(201);
    const typed = await readyJob();
    const answer = await submit(ESTIMATOR_A, typed.jobId, typed.draftId, manifestOf(typed.photoId, { r1: { name: 'Bath', roomTypeId: 'bathroom' } }));
    expect(answer).toMatchObject({ status: 409, body: { error: 'unknown_price_ids' } });
  });

  it('checks a job that is already pinned against its pin, not the newer version', async () => {
    await publish(V1);
    const { jobId, draftId, photoId } = await readyJob();
    expect((await submit(ESTIMATOR_A, jobId, draftId, manifestOf(photoId, { hall: { name: 'Hall', category: 1, wetFloorSf: 10 } }))).status).toBe(201);
    expect((await make(ESTIMATOR_A, jobId)).status).toBe(201);
    await publish(V2);
    const next = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: next, fromDraftId: draftId })).status).toBe(201);
    // Version 2's kitchen type is not in the pinned version 1.
    const kitchen = await submit(ESTIMATOR_A, jobId, next, manifestOf(photoId, { hall: { name: 'Hall', category: 1, roomTypeId: 'kitchen' } }));
    expect(kitchen).toMatchObject({ status: 409, body: { error: 'unknown_price_ids' } });
    const bathroom = await submit(ESTIMATOR_A, jobId, next, manifestOf(photoId, { hall: { name: 'Hall', category: 1, roomTypeId: 'bathroom', items: { flood_cut: '3' } } }));
    expect(bathroom.status).toBe(201);
  });
});

describe('room inputs reach the record and the estimate', () => {
  it('prices the same item in two rooms at different quantities as two lines', async () => {
    await publish(V1);
    const { jobId, draftId, photoId } = await readyJob();
    const manifest = manifestOf(photoId, {
      bath: { name: 'Bathroom', category: 1, roomTypeId: 'bathroom', waterClass: 2, ceilingHeightFt: 8, items: { flood_cut: '4' } },
      hall: { name: 'Hallway', category: 1, items: { flood_cut: '12.5' } },
    });
    expect((await submit(ESTIMATOR_A, jobId, draftId, manifest)).status).toBe(201);
    const answer = await make(ESTIMATOR_A, jobId);
    expect(answer.status).toBe(201);
    // Bathroom 4 LF x $3.00 = $12.00; Hallway 12.5 LF x $3.00 = $37.50; total $49.50.
    expect(answer.body.estimate.lines.map((line: Body) => `${line.description} = ${line.total}`)).toEqual([
      'Bathroom: 4 ft flood cut = 12.00',
      'Hallway: 4 ft flood cut = 37.50',
    ]);
    expect(answer.body.estimate.totals.low.total).toBe('49.50');
  });

  it('keeps a prep task’s submitted words after its template is edited', async () => {
    await setTemplates(['Move the vanity contents to the garage.']);
    const { jobId, draftId, photoId } = await readyJob();
    // The phone copies the template's words into the room when the estimator picks it.
    const [picked] = (await lists(ESTIMATOR_A, jobId)).body.prepTasks as string[];
    const room = { name: 'Bathroom', category: 1, prepTasks: [picked!, 'Tape off the hallway.'], findings: 'Wet drywall behind the toilet.' };
    expect((await submit(ESTIMATOR_A, jobId, draftId, manifestOf(photoId, { bath: room }))).status).toBe(201);

    // The owner edits the template afterwards.
    await setTemplates(['Empty the vanity into boxes.']);
    expect((await lists(ESTIMATOR_A, jobId)).body.prepTasks).toEqual(['Empty the vanity into boxes.']);

    // The submitted record keeps the words as picked, and so does the draft Back to editing makes from it.
    const [record] = await f.submissions(jobId);
    const snapshot = JSON.parse(record!.snapshot!.toString('utf8'));
    expect(snapshot.field.rooms).toEqual([{ id: 'bath', field: room }]);
    const next = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: next, fromDraftId: draftId })).status).toBe(201);
    expect(h.field.data()[`${h.seed.a}/${next}`]?.rooms).toEqual({ bath: room });
  });
});
