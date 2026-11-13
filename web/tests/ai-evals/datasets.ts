import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// The S7-5 evaluation datasets (docs/plans/S7.md, S7-5): synthetic only, committed as JSON Lines
// under ./data/ (one case per line). Binary inputs (voice-note audio, Live turn audio, meter photos)
// are listed in their manifest with a file path and a SHA-256 that pins it: the meter photos are
// drawn by web/scripts/render-eval-photos.ts, the audio is spoken by web/scripts/make-eval-audio.ts.

export const EVAL_DIR = fileURLToPath(new URL('./', import.meta.url));
export const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
export const STORED_DIR = fileURLToPath(new URL('./stored/', import.meta.url));

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-\\d{2}$`));
const text = z.string().min(1).max(4000);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/).nullable();
const file = (dir: string) => z.string().regex(new RegExp(`^${dir}/[a-z]{2}-\\d{2}\\.(?:wav|jpg|png)$`));

// ---- Fill scope from words (S7-7): 40 walkthrough transcripts with hand-checked labels.
// `expected` lists every change the technician's words support: room null is a job-level field.
export const SCOPE_FIELDS = ['yearBuilt', 'category', 'floorSf', 'wetFloorSf', 'wastePercent'] as const;
export const walkthroughSchema = z.strictObject({
  id: id('wt'),
  turns: z.array(z.strictObject({ speaker: z.enum(['technician', 'assistant']), text })).min(2),
  expected: z.array(
    z.strictObject({ room: z.string().min(1).nullable(), field: z.enum(SCOPE_FIELDS), value: z.number() }),
  ),
  traps: z.array(z.enum(['count', 'price', 'correction', 'unmeasured'])),
});
export type Walkthrough = z.infer<typeof walkthroughSchema>;

// ---- Findings summary (S7-6) and job summary (S7-10): 30 jobs.
const roomFacts = z.strictObject({
  name: z.string().min(1),
  category: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  floorSf: z.number().positive(),
  wetFloorSf: z.number().min(0),
  materials: z.array(z.string().min(1)),
});
export const JOB_TOPICS = [
  'rooms',
  'equipment',
  'evidence',
  'readiness',
  'sizing',
  'review',
  'claim',
  'delivery',
  'monitoring',
] as const;
export const summaryJobSchema = z.strictObject({
  id: id('sj'),
  facts: z.strictObject({
    loss: z.enum(['water', 'mold']),
    cause: z.string().min(1),
    yearBuilt: z.int().nullable(),
    rooms: z.array(roomFacts).min(1),
    airMovers: z.int().optional(),
    dehumidifiers: z.int().optional(),
    dryingDays: z.int().optional(),
    photoCount: z.int(),
    monitoringDay: z.int().optional(),
    notes: z.string(),
  }),
  status: z.enum(['draft', 'signed']),
  labels: z.strictObject({
    pre1978: z.boolean(),
    // Each group must be named (any one of its words): every room, then the cause. None of
    // mustNotMention may appear: other rooms, the wrong water category, mold on a water job.
    mustMention: z.array(z.array(z.string().min(1)).min(1)),
    mustNotMention: z.array(z.string().min(1)),
  }),
  jobSummary: z.strictObject({ available: z.array(z.enum(JOB_TOPICS)).min(1) }),
});
export type SummaryJob = z.infer<typeof summaryJobSchema>;

// ---- Prompt injection: 20 inputs, each at least three words (Model Armor returns no match for
// fewer, documents/docs.cloud.google.com/model-armor/overview) and holding no real scope fact.
export const injectionSchema = z.strictObject({
  id: id('inj'),
  channel: z.enum(['walkthrough', 'note', 'voice_note']),
  attack: z.enum(['ignore_rules', 'set_price', 'set_count', 'exfiltrate', 'role_play', 'jailbreak', 'remove_wording']),
  text,
});
export type InjectionCase = z.infer<typeof injectionSchema>;

// ---- Live (S7-16): 30 scripted technician turns. `relevant` groups: the reply names one word of
// each. A question's groups hold answer words only, so repeating the question back is not an answer.
export const liveTurnSchema = z.strictObject({
  id: id('lt'),
  kind: z.enum(['statement', 'question']),
  say: text,
  vocabulary: z.array(z.string().min(1)),
  relevant: z.array(z.array(z.string().min(1)).min(1)).min(1),
  file: file('live-turns'),
  sha256,
});
export type LiveTurn = z.infer<typeof liveTurnSchema>;

// ---- Voice notes (S7-9): 20 natural-speech notes spoken by the Live model from these scripts.
export const voiceNoteSchema = z.strictObject({
  id: id('vn'),
  script: text,
  terms: z.array(z.string().min(1)),
  numbers: z.array(z.string().regex(/^\d+(?:\.\d+)?$/)),
  file: file('voice-notes'),
  sha256,
});
export type VoiceNote = z.infer<typeof voiceNoteSchema>;

// ---- Meter photos (S7-8): 40 readable and 20 unreadable, drawn from this shot list.
export const meterPhotoSchema = z.strictObject({
  id: id('mp'),
  readable: z.boolean(),
  meter: z.string().min(1),
  value: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
  unit: z.string().min(1).nullable(),
  shot: z.string().min(1),
  file: file('meter-photos'),
  sha256,
});
export type MeterPhoto = z.infer<typeof meterPhotoSchema>;

export const DATASETS = {
  walkthroughs: { file: 'walkthroughs.jsonl', schema: walkthroughSchema, size: 40 },
  summaryJobs: { file: 'summary-jobs.jsonl', schema: summaryJobSchema, size: 30 },
  injection: { file: 'injection.jsonl', schema: injectionSchema, size: 20 },
  liveTurns: { file: 'live-turns.jsonl', schema: liveTurnSchema, size: 30 },
  voiceNotes: { file: 'voice-notes.jsonl', schema: voiceNoteSchema, size: 20 },
  meterPhotos: { file: 'meter-photos.jsonl', schema: meterPhotoSchema, size: 60 },
} as const;
export type DatasetName = keyof typeof DATASETS;
type CaseOf<N extends DatasetName> = z.infer<(typeof DATASETS)[N]['schema']>;

export function parseJsonl(source: string): unknown[] {
  return source
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`line ${index + 1} is not JSON`);
      }
    });
}

export function datasetPath(name: DatasetName): string {
  return `${DATA_DIR}${DATASETS[name].file}`;
}

export function datasetSha256(name: DatasetName): string {
  return createHash('sha256').update(readFileSync(datasetPath(name))).digest('hex');
}

export function loadDataset<N extends DatasetName>(name: N): CaseOf<N>[] {
  const { schema } = DATASETS[name];
  return parseJsonl(readFileSync(datasetPath(name), 'utf8')).map((row, index) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new Error(`${DATASETS[name].file} line ${index + 1} does not match its schema`);
    return parsed.data as CaseOf<N>;
  });
}

// Stored responses (./stored/<suite>.jsonl): synthetic answers in each feature's output shape, so
// CI tests the scorers with no model call.
export function loadStored(file: string): Map<string, unknown> {
  const rows = parseJsonl(readFileSync(`${STORED_DIR}${file}`, 'utf8'));
  const out = new Map<string, unknown>();
  for (const row of rows) {
    const parsed = z.strictObject({ id: z.string(), response: z.unknown() }).parse(row);
    out.set(parsed.id, parsed.response);
  }
  return out;
}
