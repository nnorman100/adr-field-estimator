import type { z } from 'zod';

// What every S7-5 scorer takes and returns. A scorer is a pure function of the dataset and the
// answers a run collected (or the stored answers CI uses), so the same code judges a real run on
// `test` and the provider-free tests. Pass marks are V9 A (docs/plans/S7.md section 8), written in
// each scorer next to its metric.

// One case's answer: the feature's output (and, for text features, the model's raw reply, so the
// price check sees what the model wrote before the server's price rule), or why there is none.
export type Answer = { ok: true; response: unknown; raw?: string } | { ok: false; outcome: string };
export type Answers = ReadonlyMap<string, Answer>;

// A metric's value is null when it could not be measured; an unmeasured metric never passes.
export type Metric = { name: string; value: number | null; of: number | null; mark: string; pass: boolean };
export type CaseScore = { id: string; outcome: string; checks: Record<string, boolean | number | null> };
export type Score = { metrics: Metric[]; cases: CaseScore[]; pass: boolean };

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function atLeast(name: string, count: number, of: number, min: number): Metric {
  return { name, value: count, of, mark: `>= ${min} of ${of}`, pass: count >= min };
}

export function atMost(name: string, count: number | null, of: number, max: number): Metric {
  return { name, value: count, of, mark: `<= ${max} of ${of}`, pass: count !== null && count <= max };
}

// A share of a whole; with nothing to count it is not measured.
export function shareAtLeast(name: string, part: number, whole: number, min: number): Metric {
  const value = whole === 0 ? null : round(part / whole);
  return { name, value, of: null, mark: `>= ${min}`, pass: value !== null && value >= min };
}

export function valueAtMost(name: string, value: number | null, max: number): Metric {
  return { name, value: value === null ? null : round(value), of: null, mark: `<= ${max}`, pass: value !== null && value <= max };
}

export function withinShare(name: string, value: number | null, target: number, share: number): Metric {
  const pass = value !== null && Math.abs(value - target) <= target * share;
  return { name, value: value === null ? null : round(value), of: null, mark: `${target} +/- ${share * 100}%`, pass };
}

export function score(metrics: Metric[], cases: CaseScore[]): Score {
  return { metrics, cases, pass: metrics.length > 0 && metrics.every((metric) => metric.pass) };
}

// The case's parsed response, or the reason it has none: missing (never ran), the refusal code,
// or bad_shape (the feature returned something its scorer cannot read).
export function responseFor<T>(
  answers: Answers,
  id: string,
  schema: z.ZodType<T>,
): { ok: true; response: T; raw?: string } | { ok: false; outcome: string } {
  const answer = answers.get(id);
  if (!answer) return { ok: false, outcome: 'missing' };
  if (!answer.ok) return { ok: false, outcome: answer.outcome };
  const parsed = schema.safeParse(answer.response);
  if (!parsed.success) return { ok: false, outcome: 'bad_shape' };
  return answer.raw === undefined
    ? { ok: true, response: parsed.data }
    : { ok: true, response: parsed.data, raw: answer.raw };
}

// Stored answers (CI): every stored response counts as a successful call.
export function storedAnswers(stored: ReadonlyMap<string, unknown>): Map<string, Answer> {
  return new Map([...stored].map(([id, response]) => [id, { ok: true as const, response }]));
}
