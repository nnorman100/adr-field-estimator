import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ArmorVerdict } from '@/lib/ai/armor';
import { createAiBoundary, type AiModelRequest } from '@/lib/ai/call';
import summaryDraftText from '@/lib/ai/prompts/summary-draft';
import { AI_REGISTRY } from '@/lib/ai/registry';
import { parseAiConfig } from '@/lib/config';
import type { JobIdentity } from '@/lib/ai/prompt-facts';
import type { FieldManifest } from '@/lib/field/canonical';
import {
  summaryDraftRequest,
  summaryFacts,
  summaryFactsText,
  SummaryFactsError,
  type SummaryDraftOutput,
  type SummaryFacts,
} from '@/lib/summary-draft/request';
import { loadDataset, loadStored } from '../ai-evals/datasets';
import { ADAPTERS, MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, runSuite } from '../ai-evals/runner';
import { TEXT_TEMPLATE } from '../../scripts/eval-ai';

// S7-6, the findings summary draft's request (docs/plans/S7.md): the ported prompt, the facts built
// from a field draft, and the server rules on the answer (price sentences stripped, testing advice
// only for a home built before 1978), through the real AI boundary with a fake model and Model
// Armor. The route itself is tests/db/summary-draft-api.test.ts.

const PASS: ArmorVerdict = { ok: true, category: 'passed' };
const COMPANY = '00000000-0000-4000-8000-00000000000a';
const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const NO_EXTRA = { walkthrough: [], voiceNotes: [], meterReadings: [] };

function manifest(draft: Record<string, unknown> = {}): FieldManifest {
  return {
    draft: { yearBuilt: 1972, roomOrder: ['kitchen', 'hall'], notes: 'Supply line burst under the sink.', summary: 'My own words.', airMovers: 3, ...draft },
    rooms: [
      { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40 } },
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80, findings: 'Toe kick swollen.' } },
    ],
    photos: [
      { id: 'p1', field: { roomId: 'kitchen', shotTag: 'source' } },
      { id: 'p2', field: { roomId: 'kitchen' } },
      { id: 'p3', field: {} },
    ],
  };
}

// The boundary as the route builds it, answering `answer` for every call.
function boundary(answer: unknown) {
  const requests: AiModelRequest[] = [];
  const reserved: string[] = [];
  const call = createAiBoundary({
    model: {
      async generate(request) {
        requests.push(request);
        return { text: JSON.stringify(answer), usage: { promptTokenCount: 100, candidatesTokenCount: 50 } };
      },
    },
    armor: { screenPrompt: async () => PASS, screenResponse: async () => PASS },
    quota: { take: async () => true },
    budget: {
      reserve: async ({ callId }) => {
        reserved.push(callId);
        return { ok: true, reservationId: 'r' };
      },
      settle: async () => {},
      hold: async () => {},
    },
    log: () => {},
  });
  const context = { companyId: COMPANY, actorId: ACTOR, capabilities: ['audit'], flags: { ai_summary: true } };
  return {
    requests,
    reserved,
    draft: (facts: SummaryFacts, callId?: string) => call.call(context, summaryDraftRequest(facts, { callId })),
  };
}

const answer = (overrides: Partial<SummaryDraftOutput> = {}): SummaryDraftOutput => ({
  summary: 'Category 2 water from a burst supply line affected the kitchen and the hall.',
  suggestions: ['Take a moisture reading map of each affected room daily.'],
  unpriced_work: ['Kitchen: cabinet toe kick removal is requested but not in the scope.'],
  testing_advice: ['Test for asbestos and lead before disturbing drywall.'],
  ...overrides,
});

describe('the summary draft prompt', () => {
  it('is the ported audit instruction, registered with its SHA-256 as the prompt version', () => {
    const prompt = AI_REGISTRY.summary_draft.prompt!;
    expect(prompt.text).toBe(summaryDraftText);
    expect(prompt.version).toBe(createHash('sha256').update(summaryDraftText, 'utf8').digest('hex'));
  });
});

describe('summary draft facts', () => {
  it('reads the draft in room order, without the summary being drafted', () => {
    const facts = summaryFacts(manifest(), NO_EXTRA);
    expect(facts.inspection).toEqual({
      yearBuilt: 1972,
      notes: 'Supply line burst under the sink.',
      airMovers: 3,
      rooms: [
        { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80, findings: 'Toe kick swollen.', photoCount: 2 },
        { name: 'Hall', category: 2, floorSf: 40, photoCount: 0 },
      ],
    });
    expect(facts.photoCount).toBe(3);
    expect(JSON.stringify(facts)).not.toContain('My own words.');
  });

  it('refuses a room order that does not list the room documents exactly, as Submit does', () => {
    const unlisted = { ...manifest(), rooms: [...manifest().rooms, { id: 'added', field: { name: 'Den' } }] };
    expect(() => summaryFacts(unlisted, NO_EXTRA)).toThrow(SummaryFactsError);
    const missing = { ...manifest(), rooms: manifest().rooms.filter((room) => room.id !== 'hall') };
    expect(() => summaryFacts(missing, NO_EXTRA)).toThrow(SummaryFactsError);
  });

  it('refuses a draft map the field rules would refuse, so no other key (an address) reaches the model', () => {
    expect(() => summaryFacts(manifest({ propertyAddress: '12 Synthetic Lane' }), NO_EXTRA)).toThrow(SummaryFactsError);
    expect(() =>
      summaryFacts({ ...manifest(), rooms: [{ id: 'kitchen', field: { name: 'Kitchen', latitude: 37.1 } }] }, NO_EXTRA),
    ).toThrow(SummaryFactsError);
  });

  it('states the age rule first: testing required before 1978, not from 1978, and unresolved when the year is unknown', () => {
    const rule = (draft: Record<string, unknown>) => summaryFactsText(summaryFacts(manifest(draft), NO_EXTRA)).split('\n')[0];
    expect(rule({ yearBuilt: 1977 })).toBe('App age rule: the home was built in 1977, so the app requires lead/asbestos testing before demolition.');
    expect(rule({ yearBuilt: 1978 })).toBe('App age rule: the home was built in 1978, so the app does not require lead/asbestos testing before demolition.');
    expect(rule({ yearBuilt: undefined })).toBe(
      'App age rule: the year built is not recorded, so the app has not determined whether lead/asbestos testing is required before demolition.',
    );
    const text = summaryFactsText(summaryFacts(manifest({ notes: `one${String.fromCharCode(0x2028)}two\nthree` }), NO_EXTRA));
    expect(text.split('\n')).toHaveLength(3);
  });
});

describe('summary draft server rules, through the AI boundary', () => {
  it('sends the prompt as the system instruction and the facts after it', async () => {
    const b = boundary(answer());
    const outcome = await b.draft(summaryFacts(manifest(), NO_EXTRA));
    expect(outcome.ok).toBe(true);
    const sent = b.requests[0]!.systemInstruction!;
    expect(sent).toBe(summaryDraftText);
    expect(sent.startsWith('You assist the technician reviewing a CONFIRMED structured scope.')).toBe(true);
    expect(sent).toContain('Never state a dollar amount, price, cost or total in them');
    expect(sent.endsWith('Summarize only this inspection, not examples or assistant suggestions.')).toBe(true);
    expect(b.requests[0]!.parts).toEqual([{ text: summaryFactsText(summaryFacts(manifest(), NO_EXTRA)) }]);
    expect(b.requests[0]!.responseMimeType).toBe('application/json');
  });

  it("reserves under the phone's own call id, and refuses one that is not a uuid before reserving", async () => {
    const b = boundary(answer());
    const callId = '6b0f2c9e-1d4a-4e7b-9a35-c8d2e1f04b67';
    expect(await b.draft(summaryFacts(manifest(), NO_EXTRA), callId)).toMatchObject({ ok: true, callId });
    expect(b.reserved).toEqual([callId]);
    expect(await b.draft(summaryFacts(manifest(), NO_EXTRA), 'not-a-uuid')).toMatchObject({ ok: false, refusal: { code: 'invalid_context' } });
    expect(b.reserved).toEqual([callId]);
  });

  it('strips every sentence that states a price, and drops an item left empty', async () => {
    const b = boundary(
      answer({
        summary: 'Water affected the kitchen. Drying will cost about $1,200. The hall is dry.',
        suggestions: ['The total is 900 dollars.', 'Move the contents first.'],
        unpriced_work: ['Cabinet removal is not priced yet; quote 450 for it.'],
      }),
    );
    const outcome = await b.draft(summaryFacts(manifest(), NO_EXTRA));
    expect(outcome).toMatchObject({
      ok: true,
      output: { summary: 'Water affected the kitchen. The hall is dry.', suggestions: ['Move the contents first.'], unpriced_work: [] },
    });
  });

  it('strips a price wrapped across a line break in every field', async () => {
    const wrapped = 'Cabinet removal total:\n1,200.00';
    const b = boundary(
      answer({
        summary: `Water affected the kitchen.\n${wrapped}.\nThe hall is dry.`,
        suggestions: [wrapped, 'Move the contents first.'],
        unpriced_work: [`Kitchen: toe kick removal.\n${wrapped}`],
        testing_advice: [`Test before demolition.\n${wrapped}`],
      }),
    );
    const outcome = await b.draft(summaryFacts(manifest(), NO_EXTRA));
    expect(outcome).toMatchObject({
      ok: true,
      output: {
        summary: 'Water affected the kitchen.\nThe hall is dry.',
        suggestions: ['Move the contents first.'],
        unpriced_work: ['Kitchen: toe kick removal.'],
        testing_advice: ['Test before demolition.'],
      },
    });
  });

  it('keeps testing advice only for a home built before 1978', async () => {
    const advice = async (yearBuilt: number | undefined) => {
      const outcome = await boundary(answer()).draft(summaryFacts(manifest({ yearBuilt }), NO_EXTRA));
      if (!outcome.ok) throw new Error(outcome.refusal.code);
      return outcome.output.testing_advice;
    };
    expect(await advice(1977)).toEqual(['Test for asbestos and lead before disturbing drywall.']);
    expect(await advice(1978)).toEqual([]);
    expect(await advice(2004)).toEqual([]);
    expect(await advice(undefined)).toEqual([]);
  });

  it('drops lead or asbestos testing advice from every field unless the home is known to be built before 1978', async () => {
    const said = answer({
      summary:
        'Water affected the kitchen. Test for asbestos before removing the drywall. A prior asbestos test was negative. The hall is dry.',
      suggestions: ['Take lead paint samples in the hall.', 'Have the drywall checked for asbestos.', 'Move the contents first.', 'Wet drywall leads to mold.'],
      unpriced_work: ['Asbestos testing of the ceiling is requested but not in the scope.', 'Kitchen: toe kick removal.'],
    });
    const draft = async (yearBuilt: number | undefined) => {
      const outcome = await boundary(said).draft(summaryFacts(manifest({ yearBuilt }), NO_EXTRA));
      if (!outcome.ok) throw new Error(outcome.refusal.code);
      return outcome.output;
    };
    // 1978 or later, and a year not recorded: advice goes from all four fields; a finding stays.
    for (const year of [1978, 2004, undefined]) {
      expect(await draft(year)).toEqual({
        summary: 'Water affected the kitchen. A prior asbestos test was negative. The hall is dry.',
        suggestions: ['Move the contents first.', 'Wet drywall leads to mold.'],
        unpriced_work: ['Kitchen: toe kick removal.'],
        testing_advice: [],
      });
    }
    // Before 1978 the advice stands wherever it is.
    expect(await draft(1977)).toEqual(said);
  });

  it('refuses an answer whose whole summary states prices, or that is not the summary shape', async () => {
    expect(await boundary(answer({ summary: 'It costs $500.' })).draft(summaryFacts(manifest(), NO_EXTRA))).toMatchObject({
      ok: false,
      refusal: { code: 'invalid_output' },
    });
    expect(await boundary({ ...answer(), extra: 'x' }).draft(summaryFacts(manifest(), NO_EXTRA))).toMatchObject({
      ok: false,
      refusal: { code: 'invalid_output' },
    });
  });
});

describe('the shared prompt builder', () => {
  const identity = { customerName: 'Casey Planted', propertyAddress: '12 Synthetic Lane, Unit 4, Testville, CA 94000' };
  const sent = (notes: string, who: JobIdentity = identity) => summaryDraftRequest(summaryFacts(manifest({ notes }), NO_EXTRA), { identity: who }).facts!;

  it('removes the saved name, every spelling of the saved address, emails, phones and coordinates from every string sent', () => {
    const facts = summaryFacts(
      {
        ...manifest({ notes: 'Mrs. Planted asked us to start at 12 synthetic  ln., #4; pin 37.774929, -122.419416.' }),
        rooms: [
          { id: 'hall', field: { name: 'Hall', findings: 'Meter at 37°46\'29"N by the door; lat 37.77 lon -122.42.' } },
          { id: 'kitchen', field: { name: "Casey Planted's kitchen", prepTasks: ['Call 555-0101 or casey@example.invalid at CA 94000 office'] } },
        ],
      },
      { walkthrough: [{ speaker: 'technician', text: 'Gate code for Testville is at -122.4194' }], voiceNotes: ['Planted, Casey owns it.'], meterReadings: [] },
    );
    const text = summaryDraftRequest(facts, { identity }).facts!;
    for (const planted of ['Casey', 'Planted', 'ynthetic', 'Testville', '94000', '#4', '555-0101', 'example.invalid', '37.77', '122.4', '37°46']) {
      expect(text).not.toContain(planted);
    }
    expect(text).toContain('"name":"Hall"');
    expect(text).toContain('"name":"[removed] kitchen"');
  });

  it('catches the common spellings of the saved address', () => {
    for (const variant of ['12 Synthetic Lane', '12 SYNTHETIC LN', '12 synthetic ln.', '#12 Synthetic Lane', 'Synthetic Ln', 'Unit 4', 'Apt. 4', 'Suite 4', '#4', 'testville', 'CA 94000', '94000']) {
      expect({ variant, sent: sent(`Start at ${variant} today.`) }).toEqual({ variant, sent: expect.stringContaining('Start at [removed] today.') });
    }
  });

  it('removes the full name, the surname with a title and possessives, never a name word standing alone', () => {
    const hall = { customerName: 'Mary Hall', propertyAddress: '' };
    const text = sent("Wet carpet in the hall. Mary Hall's dog was out; Mrs Hall and Hall, Mary agreed. Mary is the tenant.", hall);
    expect(text).toContain('Wet carpet in the hall. [removed] dog was out; [removed] and [removed] agreed. Mary is the tenant.');
  });

  it('leaves measurements, temperatures and words that only contain a planted part alone', () => {
    const text = sent('Cascade dryer at 12.5% moisture; readings 12.5, 13.2; room at 70°F; 3 air movers for 4 days; Canada geese.');
    expect(text).toContain('Cascade dryer at 12.5% moisture; readings 12.5, 13.2; room at 70°F; 3 air movers for 4 days; Canada geese.');
  });
});

describe('the AI settings', () => {
  it('need the text template only: a text request starts with no image template set', () => {
    const template = 'projects/dryscope/locations/us-central1/templates/dryscope-text-test';
    expect(parseAiConfig({ APP_ENV: 'test', GOOGLE_CLOUD_PROJECT: 'dryscope', MODEL_ARMOR_TEXT_TEMPLATE: template })).toEqual({
      projectId: 'dryscope',
      armorTextTemplate: template,
    });
    expect(() => parseAiConfig({ APP_ENV: 'test', GOOGLE_CLOUD_PROJECT: 'dryscope' })).toThrow(/MODEL_ARMOR_TEXT_TEMPLATE/);
  });
});

describe('the summary evaluation adapter', () => {
  it('runs every summary job through the route request and scores the stored answers as passing', async () => {
    expect(ADAPTERS.summary).toBeDefined();
    const stored = loadStored('summary.jsonl');
    const jobs = loadDataset('summaryJobs');
    let next = 0;
    const requests: AiModelRequest[] = [];
    const result = await runSuite('summary', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, {
      model: {
        async generate(request) {
          requests.push(request);
          const text = JSON.stringify(stored.get(jobs[next++]!.id));
          return { text, usage: { promptTokenCount: 2_000, candidatesTokenCount: 300 } };
        },
      },
      armor: { screenPrompt: async () => PASS, screenResponse: async () => PASS },
      armorTemplate: TEXT_TEMPLATE,
      readFile: () => null,
      commit: 'a'.repeat(40),
    });
    expect(result.promptVersion).toBe(AI_REGISTRY.summary_draft.prompt!.version);
    expect(result.counts).toMatchObject({ cases: 30, answered: 30, notRun: 0 });
    expect(result.pass).toBe(true);
    expect(requests).toHaveLength(30);
    // Each request is the route's: the job's rooms and cause in the facts, the year rule first.
    const first = jobs[0]!;
    const text = (requests[0]!.parts[0] as { text: string }).text;
    expect(text.split('\n')[0]).toContain(`built in ${first.facts.yearBuilt}`);
    expect(text).toContain(first.facts.rooms[0]!.name);
    expect(text).toContain(first.facts.cause);
  });
});
