import { createHash } from 'node:crypto';
import type { Armor } from '../../src/lib/ai/armor';
import {
  createAiBoundary,
  type AiBudgetPort,
  type AiCallerContext,
  type AiModelPort,
  type AiRequest,
} from '../../src/lib/ai/call';
import { AI_REGISTRY, type AiFeature, type AiFeatureEntry, type AiRegistry } from '../../src/lib/ai/registry';
import type { AiLogLine } from '../../src/lib/ai/telemetry';
import { datasetSha256, loadDataset, type DatasetName, type InjectionCase } from './datasets';
import { INJECTION_PROBE_PROMPT } from './injection-probe';
import type { Answer, CaseScore, Metric, Score } from './score';
import { scoreLive, scoreMeterReading, scoreVoiceNotes } from './score-media';
import { scopeOutput, scoreInjection, scoreJobSummary, scoreScopeFill, scoreSummary } from './score-text';
import type { Suite } from './suites';

// The S7-5 evaluation runner (docs/plans/S7.md, S7-5; V9 B). It runs one suite's dataset through
// the real AI boundary (web/src/lib/ai/call.ts: Model Armor, model, Zod, server rules) on `test`,
// scores the answers with the suite's scorer and returns a result that holds counts, scores, model,
// prompt version and cost, never any dataset or model text. web/scripts/eval-ai.ts is the command.
//
// The run budget is the boundary's own budget port: every call reserves its conservative bound
// (input bytes / 3 plus the output cap) against the run cap before it is sent, so a run can never
// spend past the cap ($2 at most); the first refused reservation stops the run and the result is
// incomplete. Model Armor sanitize calls are not in it (2 million tokens a month are free). The
// token budget works the same way in tokens: a call starts only when the tokens already used plus
// its bound fit, and the first one that does not stops the run.

// How a feature's step plugs its real request into the eval: build the boundary request from a
// dataset case (the job facts the feature's route would send), and map the feature's output onto
// the scorer's shape. Each feature step (S7-6 to S7-16) adds its adapter to ADAPTERS with its prompt;
// until then its suite refuses as not built yet. The injection suite needs no adapter: it sends each
// input to fill-scope through the boundary itself.
export type EvalAdapter = {
  request(item: unknown): AiRequest<unknown>;
  response(output: unknown): unknown;
};
export const ADAPTERS: Partial<Record<Suite, EvalAdapter>> = {};

type SuiteDef = {
  feature: AiFeature;
  dataset: DatasetName;
  // Owner-made files the cases point at (audio, photos), pinned by SHA-256 in the manifest.
  files: boolean;
  // The step that wires the suite's adapter.
  step: string;
  score(cases: readonly unknown[], answers: ReadonlyMap<string, Answer>): Score;
};

export const SUITE_DEFS: Readonly<Record<Suite, SuiteDef>> = {
  summary: { feature: 'summary_draft', dataset: 'summaryJobs', files: false, step: 'S7-6', score: (c, a) => scoreSummary(c as never, a) },
  job_summary: { feature: 'job_summary', dataset: 'summaryJobs', files: false, step: 'S7-10', score: (c, a) => scoreJobSummary(c as never, a) },
  scope_fill: { feature: 'scope_fill', dataset: 'walkthroughs', files: false, step: 'S7-7', score: (c, a) => scoreScopeFill(c as never, a) },
  // The screen itself, then fill-scope (the feature that turns words into draft changes) on any
  // input the screen let through.
  injection: { feature: 'scope_fill', dataset: 'injection', files: false, step: 'S7-7', score: (c, a) => scoreInjection(c as never, a) },
  meter_reading: { feature: 'meter_reading', dataset: 'meterPhotos', files: true, step: 'S7-8', score: (c, a) => scoreMeterReading(c as never, a) },
  voice_notes: { feature: 'voice_note', dataset: 'voiceNotes', files: true, step: 'S7-9', score: (c, a) => scoreVoiceNotes(c as never, a) },
  // Live runs through the relay, not call.ts: S7-16 wires it with the session totals.
  live: { feature: 'live', dataset: 'liveTurns', files: true, step: 'S7-16', score: (c, a) => scoreLive(c as never, a) },
};

// A refusal to start, with a message that is safe to print.
export class EvalRefusal extends Error {}

export const MAX_RUN_MICRO_USD = 2_000_000; // V9 B: $2 a run
// Input plus output tokens a run may use: a 40-case suite at its features' output caps fits.
export const MAX_RUN_TOKENS = 1_000_000;

// Synthetic caller for the boundary: no real company or person is ever named.
const EVAL_COMPANY = '00000000-0000-4000-8000-0000000005e5';
const EVAL_ACTOR = '00000000-0000-4000-8000-0000000005e6';

export function createRunBudget(capMicroUsd: number) {
  const open = new Map<string, number>();
  let settled = 0;
  let held = 0;
  let next = 0;
  const port: AiBudgetPort = {
    async reserve({ microUsd }) {
      const committed = settled + held + [...open.values()].reduce((a, b) => a + b, 0);
      if (committed + microUsd > capMicroUsd) return { ok: false, reason: 'daily' };
      const reservationId = `run-${(next += 1)}`;
      open.set(reservationId, microUsd);
      return { ok: true, reservationId };
    },
    async settle(reservationId, microUsd) {
      if (!open.delete(reservationId)) return;
      settled += microUsd;
    },
    async hold(reservationId) {
      const amount = open.get(reservationId);
      if (amount === undefined) return;
      open.delete(reservationId);
      held += amount;
    },
  };
  return { port, totals: () => ({ capMicroUsd, settledMicroUsd: settled, heldMicroUsd: held }) };
}

export type RunPorts = {
  model: AiModelPort;
  armor: Pick<Armor, 'screenPrompt' | 'screenResponse'>;
  armorTemplate: string;
  // A dataset file's bytes, or null when it is not there.
  readFile(relative: string): Uint8Array | null;
  commit: string | null;
  now?: () => Date;
  // Tests only: fake adapters and a registry whose features have prompts.
  adapters?: Partial<Record<Suite, EvalAdapter>>;
  registry?: AiRegistry;
};

export type EvalResult = {
  suite: Suite;
  feature: AiFeature;
  model: string | null;
  promptVersion: string | null;
  armorTemplate: string | null;
  dataset: { name: DatasetName; cases: number; sha256: string };
  commit: string | null;
  startedAt: string;
  finishedAt: string;
  cost: {
    capMicroUsd: number;
    settledMicroUsd: number;
    heldMicroUsd: number;
    tokenBudget: number;
    inputTokens: number;
    outputTokens: number;
  };
  counts: { cases: number; answered: number; refused: Record<string, number>; notRun: number };
  metrics: Metric[];
  incomplete: string[];
  pass: boolean;
  cases: CaseScore[];
};

// Files a suite needs: present and matching the manifest's SHA-256, or the run refuses to start.
export function checkFiles(cases: readonly { id: string; file: string; sha256: string | null }[], ports: Pick<RunPorts, 'readFile'>) {
  const bad = cases.filter((item) => {
    const bytes = ports.readFile(item.file);
    return !bytes || !item.sha256 || createHash('sha256').update(bytes).digest('hex') !== item.sha256;
  });
  if (bad.length > 0) {
    throw new EvalRefusal(
      `${bad.length} of ${cases.length} dataset files are missing or do not match their SHA-256 (web/tests/ai-evals/README.md, "Audio and photos").`,
    );
  }
}

// The most tokens one call can use: its input bytes / 3 and the feature's output cap, the bound
// the boundary reserves in dollars.
export function tokenBound(entry: AiFeatureEntry, request: AiRequest<unknown>): number {
  const bytes =
    (entry.prompt ? Buffer.byteLength(entry.prompt.text) : 0) +
    (request.facts ? Buffer.byteLength(request.facts) : 0) +
    (request.image?.bytes.byteLength ?? 0) +
    (request.audio?.bytes.byteLength ?? 0);
  return Math.ceil(bytes / 3) + (entry.outputTokenCap ?? 0);
}

// An injection input as fill-scope would get it: the technician's words.
export const injectionRequest = (item: InjectionCase): AiRequest<unknown> => ({
  feature: 'scope_fill',
  facts: item.text,
  schema: scopeOutput,
});

// Model Armor refusals: nothing reached the draft.
const SCREENED: ReadonlySet<string> = new Set(['input_blocked', 'output_blocked', 'screen_unavailable']);

export async function runSuite(suite: Suite, capMicroUsd: number, tokenBudget: number, ports: RunPorts): Promise<EvalResult> {
  if (!Number.isSafeInteger(capMicroUsd) || capMicroUsd <= 0 || capMicroUsd > MAX_RUN_MICRO_USD) {
    throw new EvalRefusal('The run cap must be more than $0 and at most $2.');
  }
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0 || tokenBudget > MAX_RUN_TOKENS) {
    throw new EvalRefusal(`The token budget must be more than 0 and at most ${MAX_RUN_TOKENS}.`);
  }
  const def = SUITE_DEFS[suite];
  const base = ports.registry ?? AI_REGISTRY;
  const registry: AiRegistry =
    suite === 'injection' && !base.scope_fill.prompt
      ? { ...base, scope_fill: { ...base.scope_fill, prompt: INJECTION_PROBE_PROMPT } }
      : base;
  const entry = registry[def.feature];
  const adapter = (ports.adapters ?? ADAPTERS)[suite];
  if (suite !== 'injection' && !adapter) {
    throw new EvalRefusal(`The ${suite} suite is not built yet: its feature arrives with ${def.step}.`);
  }
  const cases = loadDataset(def.dataset) as readonly ({ id: string } & Record<string, unknown>)[];
  if (def.files) checkFiles(cases as never, ports);

  const now = ports.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const budget = createRunBudget(capMicroUsd);
  const lines: AiLogLine[] = [];
  let raw: string | undefined;
  const boundary = createAiBoundary({
    model: {
      async generate(request) {
        const reply = await ports.model.generate(request);
        raw = reply.text;
        return reply;
      },
    },
    armor: ports.armor,
    quota: { take: async () => true },
    budget: budget.port,
    registry,
    log: (line) => lines.push(line),
    now,
  });
  const context: AiCallerContext = {
    companyId: EVAL_COMPANY,
    actorId: EVAL_ACTOR,
    capabilities: [entry.capability],
    flags: { [entry.flag]: true },
  };

  const answers = new Map<string, Answer>();
  const refused: Record<string, number> = {};
  let stopped: 'run_cap_reached' | 'token_budget_reached' | null = null;
  let usedModel = false;
  let usedTokens = 0;
  const call = async (request: AiRequest<unknown>): Promise<{ answer: Answer; verdict: string }> => {
    const bound = tokenBound(entry, request);
    if (usedTokens + bound > tokenBudget) {
      stopped = 'token_budget_reached';
      return { answer: { ok: false, outcome: 'not_run' }, verdict: 'not_screened' };
    }
    raw = undefined;
    usedModel = true;
    const outcome = await boundary.call(context, request);
    const line = lines[lines.length - 1];
    const reported = line ? line.inputTokens + line.outputTokens : 0;
    // Tokens Google reported; with none reported after the model may have run, the whole bound.
    const unknown = !outcome.ok && ['model_timeout', 'model_failed'].includes(outcome.refusal.code);
    usedTokens += reported > 0 ? reported : unknown ? bound : 0;
    const verdict = line?.verdict ?? 'not_screened';
    if (outcome.ok) {
      return { answer: raw === undefined ? { ok: true, response: outcome.output } : { ok: true, response: outcome.output, raw }, verdict };
    }
    refused[outcome.refusal.code] = (refused[outcome.refusal.code] ?? 0) + 1;
    if (outcome.refusal.code === 'budget') stopped = 'run_cap_reached';
    return { answer: { ok: false, outcome: outcome.refusal.code }, verdict };
  };

  for (const item of cases) {
    if (stopped) {
      answers.set(item.id, { ok: false, outcome: 'not_run' });
      continue;
    }
    if (suite !== 'injection') {
      const { answer } = await call(adapter!.request(item));
      answers.set(item.id, answer.ok ? { ...answer, response: adapter!.response(answer.response) } : answer);
      continue;
    }
    // Injection: the input goes to fill-scope through the boundary, whose Model Armor screen runs
    // before the model. A Model Armor refusal means nothing reached the draft; an input it let
    // through is answered by fill-scope, whose proposed changes are what the draft would get. Any
    // other refusal leaves the case unanswered, so the suite cannot pass on it.
    const { answer, verdict } = await call(injectionRequest(item as unknown as InjectionCase));
    if (answer.ok) {
      const { changes } = scopeOutput.parse(answer.response);
      answers.set(item.id, { ...answer, response: { verdict: 'passed', changes } });
    } else if (SCREENED.has(answer.outcome)) {
      answers.set(item.id, { ok: true, response: { verdict: answer.outcome === 'output_blocked' ? 'passed' : verdict, changes: [] } });
    } else answers.set(item.id, answer);
  }

  const scored = def.score(cases, answers);
  const incomplete: string[] = stopped ? [stopped] : [];
  const notRun = [...answers.values()].filter((a) => !a.ok && a.outcome === 'not_run').length;
  const tokens = lines.reduce(
    (sum, line) => ({ input: sum.input + (line.inputTokens ?? 0), output: sum.output + (line.outputTokens ?? 0) }),
    { input: 0, output: 0 },
  );
  return {
    suite,
    feature: def.feature,
    model: usedModel ? entry.model : null,
    promptVersion: usedModel ? (entry.prompt?.version ?? null) : null,
    armorTemplate: ports.armorTemplate,
    dataset: { name: def.dataset, cases: cases.length, sha256: datasetSha256(def.dataset) },
    commit: ports.commit,
    startedAt,
    finishedAt: now().toISOString(),
    cost: { ...budget.totals(), tokenBudget, inputTokens: tokens.input, outputTokens: tokens.output },
    counts: {
      cases: cases.length,
      answered: [...answers.values()].filter((a) => a.ok).length,
      refused,
      notRun,
    },
    metrics: scored.metrics,
    incomplete,
    pass: scored.pass && incomplete.length === 0,
    cases: scored.cases,
  };
}
