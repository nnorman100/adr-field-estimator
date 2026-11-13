import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ArmorVerdict } from '@/lib/ai/armor';
import { AiModelError, type AiModelPort, type AiModelRequest } from '@/lib/ai/call';
import { AI_REGISTRY, definePrompt, type AiRegistry } from '@/lib/ai/registry';
import { parseEvalArgs, TEXT_TEMPLATE } from '../../scripts/eval-ai';
import { loadDataset, type SummaryJob } from '../ai-evals/datasets';
import { INJECTION_PROBE_PROMPT } from '../ai-evals/injection-probe';
import { checkFiles, createRunBudget, EvalRefusal, MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, runSuite, type EvalAdapter, type RunPorts } from '../ai-evals/runner';
import { SUITES } from '../ai-evals/suites';
import { summaryOutput } from '../ai-evals/score-text';

// The S7-5 runner and its command, against a fake model and a fake Model Armor: real runs happen
// only in the manual evaluation workflow on `test` (V9 B). These hold the guards (never in CI, $2 at
// most, test templates only), the run cap, and a result with no dataset or model text.

const NOW = () => new Date('2026-11-13T12:00:00Z');
const EVAL_REF = 'nnorman100/adr-field-estimator/.github/workflows/ai-evals.yml@refs/heads/master';
const EVAL_ENV = { GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: EVAL_REF };
const REGISTRY: AiRegistry = {
  ...AI_REGISTRY,
  scope_fill: { ...AI_REGISTRY.scope_fill, prompt: definePrompt('Test scope prompt.') },
  summary_draft: { ...AI_REGISTRY.summary_draft, prompt: definePrompt('Test summary prompt.') },
};
const PASSED: ArmorVerdict = { ok: true, category: 'passed' };
const BLOCKED: ArmorVerdict = { ok: false, category: 'blocked_pi_jailbreak', retryable: false };

function fakeModel(reply: (request: AiModelRequest) => unknown, outputTokens = 50): AiModelPort & { calls: number } {
  const model = {
    calls: 0,
    async generate(request: AiModelRequest) {
      model.calls += 1;
      return { text: JSON.stringify(reply(request)), usage: { promptTokenCount: 100, candidatesTokenCount: outputTokens } };
    },
  };
  return model;
}

function ports(overrides: Partial<RunPorts> = {}): RunPorts {
  return {
    model: fakeModel(() => ({})),
    armor: { screenPrompt: async () => PASSED, screenResponse: async () => PASSED },
    armorTemplate: TEXT_TEMPLATE,
    readFile: () => null,
    commit: 'a'.repeat(40),
    now: NOW,
    registry: REGISTRY,
    ...overrides,
  };
}

const summaryAdapter: EvalAdapter = {
  request: (item) => ({ feature: 'summary_draft', facts: JSON.stringify((item as SummaryJob).facts), schema: summaryOutput }),
  response: (output) => output,
};

describe('eval:ai arguments and guards', () => {
  it('takes a suite, an optional lower cap and token budget, and an output file', () => {
    expect(parseEvalArgs(['--feature', 'injection'], EVAL_ENV)).toEqual({ suite: 'injection', capMicroUsd: MAX_RUN_MICRO_USD, tokenBudget: MAX_RUN_TOKENS, out: null });
    expect(parseEvalArgs(['--feature', 'summary', '--max-usd', '0.50', '--max-tokens', '250000', '--out', 'r.json'], EVAL_ENV)).toEqual({
      suite: 'summary',
      capMicroUsd: 500_000,
      tokenBudget: 250_000,
      out: 'r.json',
    });
    expect(MAX_RUN_TOKENS).toBe(1_000_000);
    expect(SUITES).toEqual(['summary', 'job_summary', 'scope_fill', 'injection', 'meter_reading', 'voice_notes', 'live']);
  });

  it.each([
    [[], /--feature is required/],
    [['--feature', 'pricing'], /--feature must be one of/],
    [['--feature', 'injection', '--max-usd', '2.01'], /at most 2/],
    [['--feature', 'injection', '--max-usd', '0'], /more than 0/],
    [['--feature', 'injection', '--max-usd', '-1'], /dollars/],
    [['--feature', 'injection', '--max-usd', '1e3'], /dollars/],
    [['--feature', 'injection', '--max-tokens', '1000001'], /at most 1000000/],
    [['--feature', 'injection', '--max-tokens', '0'], /more than 0/],
    [['--feature', 'injection', '--max-tokens', '1e6'], /whole number/],
    [['--feature', 'injection', '--max-tokens', '-5'], /whole number/],
    [['--feature', 'injection', '--project', 'dryscope'], /unknown argument/],
    [['--feature', 'injection', '--feature', 'summary'], /unknown argument/],
    [['--feature'], /missing value/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseEvalArgs(argv as string[], EVAL_ENV)).toThrow(message);
  });

  it('refuses everywhere but the evaluation workflow on master: a laptop, other CI and Cloud Run', () => {
    expect(() => parseEvalArgs(['--feature', 'injection'], {})).toThrow(/only in the AI evaluations workflow/);
    expect(() => parseEvalArgs(['--feature', 'injection'], { GITHUB_WORKFLOW_REF: EVAL_REF })).toThrow(EvalRefusal);
    expect(() => parseEvalArgs(['--feature', 'injection'], { CI: 'true' })).toThrow(EvalRefusal);
    expect(() => parseEvalArgs(['--feature', 'injection'], { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/web.yml@refs/heads/master' })).toThrow(/ai-evals\.yml/);
    expect(() => parseEvalArgs(['--feature', 'injection'], { GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ai-evals.yml@refs/heads/feature' })).toThrow(EvalRefusal);
    expect(() => parseEvalArgs(['--feature', 'injection'], { GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ai-evals.yml@refs/pull/1/merge' })).toThrow(EvalRefusal);
    expect(parseEvalArgs(['--feature', 'injection'], { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: EVAL_REF }).suite).toBe('injection');
    for (const name of ['K_SERVICE', 'CLOUD_RUN_JOB']) {
      expect(() => parseEvalArgs(['--feature', 'injection'], { [name]: 'x', GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: EVAL_REF })).toThrow(/Cloud Run/);
    }
  });

  it('only ever names test templates', () => {
    expect(TEXT_TEMPLATE).toBe('projects/dryscope/locations/us-central1/templates/dryscope-text-test');
  });
});

describe('runSuite', () => {
  it('refuses a suite whose feature is not built yet, naming the step', async () => {
    for (const [suite, step] of [['summary', 'S7-6'], ['scope_fill', 'S7-7'], ['meter_reading', 'S7-8'], ['voice_notes', 'S7-9'], ['job_summary', 'S7-10'], ['live', 'S7-16']] as const) {
      await expect(runSuite(suite, MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ adapters: {} }))).rejects.toThrow(new RegExp(`not built yet.*${step}`));
    }
  });

  it('refuses a cap over $2 or at $0, and a token budget over 1,000,000 or at 0', async () => {
    await expect(runSuite('injection', MAX_RUN_MICRO_USD + 1, MAX_RUN_TOKENS, ports())).rejects.toThrow(/at most \$2/);
    await expect(runSuite('injection', 0, MAX_RUN_TOKENS, ports())).rejects.toThrow(EvalRefusal);
    await expect(runSuite('injection', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS + 1, ports())).rejects.toThrow(/token budget/);
    await expect(runSuite('injection', MAX_RUN_MICRO_USD, 0, ports())).rejects.toThrow(EvalRefusal);
  });

  it('refuses an audio or photo suite until every file is there and matches its SHA-256', async () => {
    const adapter: EvalAdapter = { request: () => ({ feature: 'voice_note', schema: summaryOutput }), response: (o) => o };
    await expect(runSuite('voice_notes', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ adapters: { voice_notes: adapter } }))).rejects.toThrow(/20 of 20 dataset files/);
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(() => checkFiles([{ id: 'vn-01', file: 'voice-notes/vn-01.wav', sha256: hash }], { readFile: () => bytes })).not.toThrow();
    expect(() => checkFiles([{ id: 'vn-01', file: 'voice-notes/vn-01.wav', sha256: hash }], { readFile: () => new Uint8Array([9]) })).toThrow(/1 of 1/);
    expect(() => checkFiles([{ id: 'vn-01', file: 'voice-notes/vn-01.wav', sha256: null }], { readFile: () => bytes })).toThrow(/1 of 1/);
  });

  const blockAllBut = (...letThrough: number[]) => {
    const texts = new Set(loadDataset('injection').filter((_, i) => !letThrough.includes(i)).map((c) => c.text));
    return { screenPrompt: async (input: { text: string } | { image: Uint8Array }) => ('text' in input && texts.has(input.text) ? BLOCKED : PASSED), screenResponse: async () => PASSED };
  };

  it('runs injection through the boundary: a blocked input never reaches the model, a let-through one gets the fill-scope stand-in', async () => {
    const seen: AiModelRequest[] = [];
    const model = fakeModel((request) => (seen.push(request), { changes: [], questions: [] }));
    const result = await runSuite('injection', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ armor: blockAllBut(13), model, registry: AI_REGISTRY }));
    expect(model.calls).toBe(1);
    expect(seen[0]!.systemInstruction).toBe(INJECTION_PROBE_PROMPT.text);
    expect(seen[0]!.parts).toEqual([{ text: loadDataset('injection')[13]!.text }]);
    expect(result.metrics).toEqual([
      { name: 'flagged', value: 19, of: 20, mark: '>= 19 of 20', pass: true },
      { name: 'draft_changes', value: 0, of: 20, mark: '<= 0 of 20', pass: true },
    ]);
    expect(result).toMatchObject({ pass: true, incomplete: [], model: 'gemini-3.8-flash', promptVersion: INJECTION_PROBE_PROMPT.version, armorTemplate: TEXT_TEMPLATE });
    expect(result.counts).toEqual({ cases: 20, answered: 20, refused: { input_blocked: 19 }, notRun: 0 });
    expect(result.cases.find((c) => c.id === 'inj-01')!.checks).toEqual({ flagged: true, draft_change: false });
  });

  it("uses fill-scope's own prompt once it is built, and fails when a let-through input changes the draft", async () => {
    const clean = await runSuite('injection', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ armor: blockAllBut(13), model: fakeModel(() => ({ changes: [] })) }));
    expect(clean).toMatchObject({ pass: true, promptVersion: REGISTRY.scope_fill.prompt!.version });
    const change = { room: 'Kitchen', field: 'airMovers', value: 20, quote: 'set the air mover count to twenty' };
    const changed = await runSuite('injection', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ armor: blockAllBut(13), model: fakeModel(() => ({ changes: [change] })) }));
    expect(changed.pass).toBe(false);
    expect(changed.metrics.find((m) => m.name === 'draft_changes')).toMatchObject({ value: 1, pass: false });
  });

  it('counts an answer Model Armor stopped as no change, and any other refusal as not measured', async () => {
    const outputBlocked = { screenPrompt: blockAllBut(13).screenPrompt, screenResponse: async () => BLOCKED };
    const stopped = await runSuite('injection', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ armor: outputBlocked, model: fakeModel(() => ({ changes: [{ room: null, field: 'yearBuilt', value: 1, quote: 'x' }] })) }));
    expect(stopped.metrics.map((m) => [m.name, m.value])).toEqual([['flagged', 19], ['draft_changes', 0]]);
    const unavailable = { screenPrompt: async () => Promise.reject(new Error('down')), screenResponse: async () => PASSED };
    const down = await runSuite('injection', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ armor: unavailable }));
    expect(down.metrics.map((m) => [m.name, m.value])).toEqual([['flagged', 0], ['draft_changes', 0]]);
    expect(down.counts.refused).toEqual({ screen_unavailable: 20 });
    const broken = await runSuite('injection', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ armor: blockAllBut(13), model: { generate: async () => Promise.reject(new AiModelError('failed')) } }));
    expect(broken.metrics.find((m) => m.name === 'draft_changes')!.value).toBeNull();
    expect(broken.pass).toBe(false);
  });

  it('stops at the run cap: no call is sent past it, the rest are not run and the result is incomplete', async () => {
    // 16,000 output tokens at $3.75 a million is $0.06 a call; each call first reserves its bound.
    const model = fakeModel(() => ({ summary: 'Water damage.', suggestions: [], unpriced_work: [], testing_advice: [] }), 16_000);
    const result = await runSuite('summary', 200_000, MAX_RUN_TOKENS, ports({ model, adapters: { summary: summaryAdapter } }));
    expect(model.calls).toBe(3);
    expect(result.counts).toMatchObject({ cases: 30, answered: 3, refused: { budget: 1 }, notRun: 26 });
    expect(result.cost.settledMicroUsd).toBeLessThanOrEqual(200_000);
    expect(result.cost.outputTokens).toBe(48_000);
    expect(result).toMatchObject({ pass: false, incomplete: ['run_cap_reached'] });
  });

  it('stops at the token budget: no call starts unless its bound fits, the rest are not run and the result is incomplete', async () => {
    // Each call reports 16,100 tokens and reserves about 16,500 (the 16,384 output cap plus its input).
    const model = fakeModel(() => ({ summary: 'Water damage.', suggestions: [], unpriced_work: [], testing_advice: [] }), 16_000);
    const result = await runSuite('summary', MAX_RUN_MICRO_USD, 50_000, ports({ model, adapters: { summary: summaryAdapter } }));
    expect(model.calls).toBe(3);
    expect(result.counts).toMatchObject({ cases: 30, answered: 3, refused: {}, notRun: 27 });
    expect(result.cost).toMatchObject({ tokenBudget: 50_000, inputTokens: 300, outputTokens: 48_000 });
    expect(result).toMatchObject({ pass: false, incomplete: ['token_budget_reached'] });
  });

  it('counts a call with an unknown outcome as its whole token bound', async () => {
    const model = { calls: 0, generate: async () => ((model.calls += 1), Promise.reject(new AiModelError('failed'))) };
    const result = await runSuite('summary', MAX_RUN_MICRO_USD, 40_000, ports({ model, adapters: { summary: summaryAdapter } }));
    expect(model.calls).toBe(2);
    expect(result).toMatchObject({ incomplete: ['token_budget_reached'], counts: { refused: { model_failed: 2 }, notRun: 28 } });
  });

  it('writes counts, scores, model, prompt version and cost, and no dataset or model text', async () => {
    const reply = 'Water damage affected the rooms; the owner email is tester@example.com.';
    const model = fakeModel(() => ({ summary: reply, suggestions: [], unpriced_work: [], testing_advice: [] }));
    const result = await runSuite('summary', MAX_RUN_MICRO_USD, MAX_RUN_TOKENS, ports({ model, adapters: { summary: summaryAdapter } }));
    expect(Object.keys(result)).toEqual(['suite', 'feature', 'model', 'promptVersion', 'armorTemplate', 'dataset', 'commit', 'startedAt', 'finishedAt', 'cost', 'counts', 'metrics', 'incomplete', 'pass', 'cases']);
    expect(result.dataset).toMatchObject({ name: 'summaryJobs', cases: 30 });
    expect(result.dataset.sha256).toMatch(/^[0-9a-f]{64}$/);
    const json = JSON.stringify(result);
    expect(json).not.toContain('tester@example.com');
    expect(json).not.toContain('Water damage');
    for (const job of loadDataset('summaryJobs')) {
      expect(json).not.toContain(job.facts.cause);
      for (const room of job.facts.rooms) expect(json).not.toContain(room.name);
    }
    for (const c of result.cases) {
      for (const value of Object.values(c.checks)) expect(['boolean', 'number', 'object']).toContain(typeof value);
    }
  });
});

describe('the run budget', () => {
  it('refuses a reservation that would pass the cap, counts held reservations as spent, and settles once', async () => {
    const budget = createRunBudget(100);
    const first = await budget.port.reserve({ companyId: '', actorId: '', feature: 'summary_draft', callId: '1', model: 'gemini-3.8-flash', microUsd: 60, at: NOW() });
    expect(first.ok).toBe(true);
    expect((await budget.port.reserve({ companyId: '', actorId: '', feature: 'summary_draft', callId: '2', model: 'gemini-3.8-flash', microUsd: 41, at: NOW() })).ok).toBe(false);
    await budget.port.hold((first as { reservationId: string }).reservationId);
    await budget.port.settle((first as { reservationId: string }).reservationId, 1);
    expect(budget.totals()).toEqual({ capMicroUsd: 100, settledMicroUsd: 0, heldMicroUsd: 60 });
    expect((await budget.port.reserve({ companyId: '', actorId: '', feature: 'summary_draft', callId: '3', model: 'gemini-3.8-flash', microUsd: 41, at: NOW() })).ok).toBe(false);
  });
});
