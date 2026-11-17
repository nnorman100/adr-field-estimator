import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArmorVerdict } from '@/lib/ai/armor';
import type { AiModelRequest } from '@/lib/ai/call';
import type { AiLogLine } from '@/lib/ai/telemetry';
import type { SummaryDraftOutput } from '@/lib/summary-draft/request';
import { flow, json } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S7-6, the findings summary draft (docs/plans/S7.md) through the real route file as the runtime role
// against Postgres: the real AI boundary and spend ledger, with a fake model and a fake Model Armor,
// and the field drafts' stand-in read only (summary-draft-fake.ts). A job is made through the real
// jobs and photo routes, so the estimator owns its field work.
const live = vi.hoisted(() => ({
  harness: null as Harness | null,
  answer: null as unknown,
  requests: [] as AiModelRequest[],
  logs: [] as AiLogLine[],
}));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/summary-draft/services', async () => {
  const { summaryDraftService } = await import('@/lib/summary-draft/service');
  const { createAiBoundary } = await import('@/lib/ai/call');
  const { postgresAiBudget } = await import('@/lib/ai/budget');
  const { fieldSummaryReader } = await import('./summary-draft-fake');
  const PASS: ArmorVerdict = { ok: true, category: 'passed' };
  return {
    summaryDraftServices: () => {
      const ledger = postgresAiBudget(live.harness!.handle.db);
      const boundary = createAiBoundary({
        model: {
          async generate(request) {
            live.requests.push(request);
            return { text: JSON.stringify(live.answer), usage: { promptTokenCount: 1_000, candidatesTokenCount: 200 } };
          },
        },
        armor: { screenPrompt: async () => PASS, screenResponse: async () => PASS },
        quota: ledger,
        budget: ledger,
        log: (line) => live.logs.push(line),
      });
      return summaryDraftService(live.harness!.handle.db, fieldSummaryReader(live.harness!.field), () => boundary);
    },
  };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const summaryRoute = await import('@/app/api/jobs/[jobId]/ai/summary-draft/route');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
const { AI_REGISTRY } = await import('@/lib/ai/registry');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };

const unused = async () => new Response(null, { status: 500 });
const f = flow(() => h, { createJob: jobsRoute.POST, putPhoto: photoRoute.PUT, submit: unused, nextDraft: unused, request, params });

// Planted where a model request or a log line must never show them: the customer and the property
// address are on the job row only; the email and coordinates are typed into the job notes.
const ADDRESS = '12 Synthetic Lane, Testville';
const CUSTOMER = 'Casey Planted';
const EMAIL = 'planted.person@example.invalid';
const COORDINATES = '37.774929, -122.419416';

const ANSWER: SummaryDraftOutput = {
  summary: 'Category 2 water from a burst supply line affected the kitchen and the hall.',
  suggestions: ['Take a moisture reading map of each affected room daily.'],
  unpriced_work: ['Kitchen: cabinet toe kick removal is requested but not in the scope.'],
  testing_advice: ['Test for asbestos and lead before disturbing drywall or flooring.'],
};

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  live.answer = ANSWER;
  live.requests = [];
  live.logs = [];
  // The switch on for both companies, so a refusal of B's owner is the job's, not the switch's.
  await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'ai_summary', true), (${h.seed.b}, 'ai_summary', true)`;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const draftSummary = (claims: FakeClaims | null, jobId: string, callId = randomUUID()) =>
  json(summaryRoute.POST(request(claims, `/api/jobs/${jobId}/ai/summary-draft`, { method: 'POST', body: { callId } }), params({ jobId }))) as Promise<{
    status: number;
    body: Body;
  }>;

// Company A's job in Check Scope: its estimator's field work, with the customer and address saved.
async function editingJob(draft: Record<string, unknown> = {}) {
  const ready = await f.readyJob(ESTIMATOR_A, h.seed.a);
  const customer = { revision: (await f.job(ready.jobId)).revision, changeId: randomUUID(), name: CUSTOMER, phone: '555-0101', email: 'casey@example.invalid', propertyAddress: ADDRESS };
  const saved = await customerRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${ready.jobId}/customer`, { method: 'PUT', body: customer }), params({ jobId: ready.jobId }));
  expect(saved.status).toBe(200);
  h.field.put(h.seed.a, ready.draftId, { draft: { ...(ready.manifest.draft as Record<string, unknown>), ...draft } });
  return ready;
}

const results = () => h.admin<Body[]>`SELECT call_id::text, job_id::text, draft_id::text, actor_id::text, feature, status, output, prompt_version, model, verdict_category FROM ai_results`;
const ledger = () => h.admin<Body[]>`SELECT call_id::text, feature, state, settled_micro_usd FROM ai_ledger`;

describe('POST /api/jobs/{jobId}/ai/summary-draft', () => {
  it('stores the AI draft as a proposal and answers it, writing nothing to the field draft', async () => {
    const job = await editingJob();
    const before = h.field.data();
    const calls = h.field.calls.length;
    const callId = randomUUID();
    const { status, body } = await draftSummary(ESTIMATOR_A, job.jobId, callId);
    expect(status).toBe(201);
    expect(body.result).toMatchObject({
      callId,
      jobId: job.jobId,
      draftId: job.draftId,
      status: 'proposed',
      model: 'gemini-3.8-flash',
      promptVersion: AI_REGISTRY.summary_draft.prompt!.version,
      proposal: ANSWER,
    });
    expect(await results()).toEqual([
      {
        call_id: callId,
        job_id: job.jobId,
        draft_id: job.draftId,
        actor_id: h.seed.estimatorA.actor,
        feature: 'summary_draft',
        status: 'proposed',
        output: ANSWER,
        prompt_version: AI_REGISTRY.summary_draft.prompt!.version,
        model: 'gemini-3.8-flash',
        verdict_category: 'passed',
      },
    ]);
    expect(await ledger()).toEqual([{ call_id: callId, feature: 'summary_draft', state: 'settled', settled_micro_usd: expect.any(String) }]);
    // The model got the draft's facts; the field draft is exactly as it was and was only read.
    expect(live.requests).toHaveLength(1);
    expect(JSON.stringify(live.requests[0]!.parts)).toContain('Kitchen');
    expect(h.field.data()).toEqual(before);
    expect(h.field.calls.slice(calls)).toEqual([]);
    expect(JSON.stringify(h.field.data())).not.toContain(ANSWER.summary);
  });

  it('answers the same proposal for the same call id without a second model call, and refuses the id for another job', async () => {
    const job = await editingJob();
    const callId = randomUUID();
    const first = await draftSummary(ESTIMATOR_A, job.jobId, callId);
    expect(first.status).toBe(201);
    live.answer = { ...ANSWER, summary: 'A different answer.' };
    const again = await draftSummary(ESTIMATOR_A, job.jobId, callId);
    expect(again).toEqual({ status: 200, body: first.body });
    expect(live.requests).toHaveLength(1);
    const other = await editingJob();
    expect(await draftSummary(ESTIMATOR_A, other.jobId, callId)).toMatchObject({ status: 409, body: { error: 'call_reused' } });
    expect(live.requests).toHaveLength(1);
    expect(await results()).toHaveLength(1);
  });

  it('strips every sentence that states a price before the proposal is stored', async () => {
    const job = await editingJob();
    live.answer = {
      ...ANSWER,
      summary: 'Water affected the kitchen. Drying will cost about $1,200. The hall is dry.',
      suggestions: ['The total is 900 dollars.', 'Move the contents first.'],
    };
    const { status, body } = await draftSummary(ESTIMATOR_A, job.jobId);
    expect(status).toBe(201);
    const expected = { summary: 'Water affected the kitchen. The hall is dry.', suggestions: ['Move the contents first.'] };
    expect(body.result.proposal).toMatchObject(expected);
    expect((await results())[0]!.output).toMatchObject(expected);
    expect(JSON.stringify(await results())).not.toMatch(/\$|dollars|cost/);
  });

  it('drops testing advice for a home built in 1978 or later, or of unknown age, and keeps it before 1978', async () => {
    const advice = async (yearBuilt: number | undefined) => {
      const job = await editingJob({ yearBuilt });
      const { status, body } = await draftSummary(ESTIMATOR_A, job.jobId);
      expect(status).toBe(201);
      return body.result.proposal.testing_advice;
    };
    expect(await advice(1977)).toEqual(ANSWER.testing_advice);
    expect(await advice(1978)).toEqual([]);
    expect(await advice(1995)).toEqual([]);
    expect(await advice(undefined)).toEqual([]);
    const stored = (await results()).map((row) => row.output.testing_advice);
    expect(stored.filter((list: string[]) => list.length > 0)).toEqual([ANSWER.testing_advice]);
  });

  it('answers the switch-off refusal when ai_summary is off, reading the draft and spending nothing', async () => {
    const job = await editingJob();
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'ai_summary'`;
    const { status, body } = await draftSummary(ESTIMATOR_A, job.jobId);
    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'ai_feature_off',
      message: 'This AI feature is not switched on for your company. Your field work is saved; you can keep working without AI.',
      retryable: false,
      fieldWorkContinues: true,
    });
    expect(live.requests).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await results()).toEqual([]);
  });

  it('tells another company’s owner the job does not exist, and calls no model', async () => {
    const job = await editingJob();
    expect(await draftSummary(OWNER_B, job.jobId)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(live.requests).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await results()).toEqual([]);
  });

  it('sends the model no customer name or property address, and logs no planted email, address or coordinates', async () => {
    const job = await editingJob({ notes: `Owner asked us to email ${EMAIL}; meter photo tagged at ${COORDINATES}; house at ${ADDRESS}.` });
    const written: string[] = [];
    const capture = (stream: NodeJS.WriteStream) =>
      vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    const spies = [capture(process.stdout), capture(process.stderr)];
    const consoles = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void written.push(args.map(String).join(' '))),
    );
    let status: number;
    try {
      ({ status } = await draftSummary(ESTIMATOR_A, job.jobId));
    } finally {
      for (const spy of [...spies, ...consoles]) spy.mockRestore();
    }
    expect(status).toBe(201);
    // The job row's customer is never read into a request; only the technician's own notes are sent.
    const sent = JSON.stringify(live.requests[0]);
    expect(sent).not.toContain(CUSTOMER);
    expect(sent).toContain(EMAIL);
    // The one AI log line holds fixed fields only.
    expect(live.logs).toHaveLength(1);
    const out = JSON.stringify(live.logs) + written.join('\n');
    for (const planted of [EMAIL, COORDINATES, ADDRESS, CUSTOMER, '37.774929']) expect(out).not.toContain(planted);
  });
});
