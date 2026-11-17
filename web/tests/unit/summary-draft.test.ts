import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ArmorVerdict } from '@/lib/ai/armor';
import { createAiBoundary, type AiModelRequest } from '@/lib/ai/call';
import summaryDraftText from '@/lib/ai/prompts/summary-draft';
import { AI_REGISTRY } from '@/lib/ai/registry';
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
      { id: 'removed', field: { name: 'Old room' } },
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
    draft: (facts: SummaryFacts, callId?: string) => call.call(context, summaryDraftRequest(facts, callId)),
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
    expect(summaryDraftText.startsWith('You assist the technician reviewing a CONFIRMED structured scope.')).toBe(true);
    expect(summaryDraftText).toContain('Never state a dollar amount, price, cost or total in them');
    expect(summaryDraftText.endsWith('Summarize only this inspection, not examples or assistant suggestions.')).toBe(true);
  });
});

describe('summary draft facts', () => {
  it('reads the draft in room order, without the summary being drafted or rooms the order does not list', () => {
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
    expect(JSON.stringify(facts)).not.toContain('Old room');
  });

  it('refuses a draft map the field rules would refuse, so no other key (an address) reaches the model', () => {
    expect(() => summaryFacts(manifest({ propertyAddress: '12 Synthetic Lane' }), NO_EXTRA)).toThrow(SummaryFactsError);
    expect(() =>
      summaryFacts({ ...manifest(), rooms: [{ id: 'kitchen', field: { name: 'Kitchen', latitude: 37.1 } }] }, NO_EXTRA),
    ).toThrow(SummaryFactsError);
  });

  it('states the age rule first: testing required before 1978, not from 1978, not when the year is unknown', () => {
    const rule = (draft: Record<string, unknown>) => summaryFactsText(summaryFacts(manifest(draft), NO_EXTRA)).split('\n')[0];
    expect(rule({ yearBuilt: 1977 })).toBe('App age rule: the home was built in 1977, so the app requires lead/asbestos testing before demolition.');
    expect(rule({ yearBuilt: 1978 })).toBe('App age rule: the home was built in 1978, so the app does not require lead/asbestos testing before demolition.');
    expect(rule({ yearBuilt: undefined })).toBe(
      'App age rule: the year built is not recorded, so the app does not require lead/asbestos testing before demolition.',
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
    expect(b.requests[0]!.systemInstruction).toBe(summaryDraftText);
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
