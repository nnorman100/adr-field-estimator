import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DATA_DIR, DATASETS, loadDataset, STORED_DIR, type DatasetName } from '../ai-evals/datasets';
import { looseText, normalizeWords, numbersIn } from '../ai-evals/text';

// S7-5 datasets (docs/plans/S7.md, S7-5): the sizes the plan names, synthetic data only, and labels
// that agree with the text they label, so a scorer is never judged against a wrong answer key.

describe('dataset sizes and shape', () => {
  it.each(Object.entries(DATASETS))('%s has its planned size, unique ids and valid rows', (name, spec) => {
    const rows = loadDataset(name as DatasetName);
    expect(rows).toHaveLength(spec.size);
    expect(new Set(rows.map((row) => row.id)).size).toBe(spec.size);
  });

  it('has 40 readable and 20 unreadable meter photos', () => {
    const photos = loadDataset('meterPhotos');
    expect(photos.filter((p) => p.readable && p.value !== null)).toHaveLength(40);
    expect(photos.filter((p) => !p.readable && p.value === null)).toHaveLength(20);
  });

  it('pins every binary file by SHA-256 once it is added, and lists no file twice', () => {
    for (const name of ['voiceNotes', 'liveTurns', 'meterPhotos'] as const) {
      const rows = loadDataset(name);
      expect(new Set(rows.map((row) => row.file)).size).toBe(rows.length);
      for (const row of rows) expect(row.file.startsWith(`${name === 'voiceNotes' ? 'voice-notes' : name === 'liveTurns' ? 'live-turns' : 'meter-photos'}/${row.id}.`)).toBe(true);
    }
  });
});

describe('synthetic data only (hard rule 6)', () => {
  const files = [
    ...readdirSync(DATA_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => `${DATA_DIR}${f}`),
    ...readdirSync(STORED_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => `${STORED_DIR}${f}`),
  ];

  it('scans every dataset and stored answer file', () => {
    expect(files.length).toBe(13);
  });

  it.each(files)('%s holds no email, phone number, street address, coordinates or link', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // email
    expect(text).not.toMatch(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/); // phone
    expect(text).not.toMatch(/\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Blvd)\b/); // street address
    expect(text).not.toMatch(/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/); // latitude, longitude
    expect(text).not.toMatch(/https?:\/\//i);
  });
});

describe('walkthrough labels', () => {
  const walks = loadDataset('walkthroughs');
  const technician = (turns: { speaker: string; text: string }[]) =>
    turns.filter((t) => t.speaker === 'technician').map((t) => t.text).join(' ');

  it('labels every value the technician said, in their own words', () => {
    for (const walk of walks) {
      const said = numbersIn(technician(walk.turns));
      for (const e of walk.expected) expect(said.has(String(e.value)), `${walk.id} ${e.field} ${e.value}`).toBe(true);
    }
  });

  it('names every labelled room in the conversation', () => {
    for (const walk of walks) {
      const all = looseText(walk.turns.map((t) => t.text).join(' '));
      for (const e of walk.expected) if (e.room) expect(all, `${walk.id} ${e.room}`).toContain(e.room.toLowerCase());
    }
  });

  it('covers counts, prices, corrections and unmeasured rooms, and never labels a count or price', () => {
    const traps = new Set(walks.flatMap((w) => w.traps));
    expect([...traps].sort()).toEqual(['correction', 'count', 'price', 'unmeasured']);
    expect(walks.filter((w) => w.traps.includes('count')).length).toBeGreaterThanOrEqual(10);
    expect(walks.filter((w) => w.traps.includes('price')).length).toBeGreaterThanOrEqual(10);
    expect(walks.reduce((n, w) => n + w.expected.length, 0)).toBeGreaterThanOrEqual(200);
  });
});

describe('summary job labels', () => {
  const jobs = loadDataset('summaryJobs');

  it('marks pre-1978 exactly when the year built is before 1978, with both sides and unknown years covered', () => {
    for (const job of jobs) {
      expect(job.labels.pre1978).toBe(job.facts.yearBuilt !== null && job.facts.yearBuilt < 1978);
    }
    expect(jobs.filter((j) => j.labels.pre1978).length).toBeGreaterThanOrEqual(8);
    expect(jobs.filter((j) => !j.labels.pre1978 && j.facts.yearBuilt !== null).length).toBeGreaterThanOrEqual(8);
    expect(jobs.some((j) => j.facts.yearBuilt === 1978)).toBe(true);
    expect(jobs.some((j) => j.facts.yearBuilt === null)).toBe(true);
  });

  it('asks for every room and forbids only words absent from the facts', () => {
    for (const job of jobs) {
      expect(job.labels.mustMention.map((g) => g[0])).toEqual(job.facts.rooms.map((r) => r.name.toLowerCase()));
      const facts = JSON.stringify(job.facts).toLowerCase();
      for (const word of job.labels.mustNotMention) expect(facts, `${job.id} ${word}`).not.toContain(word);
    }
  });

  it('offers the job summary topics the old app always had, plus the conditional ones only when their facts exist', () => {
    for (const job of jobs) {
      const available = job.jobSummary.available;
      expect(available).toEqual(expect.arrayContaining(['rooms', 'equipment', 'evidence', 'review', 'claim']));
      expect(available.includes('sizing')).toBe(job.facts.airMovers !== undefined);
      expect(available.includes('monitoring')).toBe(job.facts.monitoringDay !== undefined);
      expect(available.includes('delivery')).toBe(job.status === 'signed');
    }
  });
});

describe('injection inputs', () => {
  it('are at least three words (Model Armor does not judge fewer) and hold no real scope fact', () => {
    for (const item of loadDataset('injection')) {
      expect(normalizeWords(item.text).length).toBeGreaterThanOrEqual(3);
      expect(item.text).not.toMatch(/square feet|category (?:one|two|three|[123])\b|built in/i);
    }
  });
});

describe('voice notes and Live turns', () => {
  it('list only terms and numbers their scripts contain', () => {
    for (const note of loadDataset('voiceNotes')) {
      const words = normalizeWords(note.script).join(' ');
      for (const term of note.terms) expect(words, `${note.id} ${term}`).toContain(normalizeWords(term).join(' '));
      for (const n of note.numbers) expect(numbersIn(note.script).has(n), `${note.id} ${n}`).toBe(true);
    }
    for (const turn of loadDataset('liveTurns')) {
      const words = normalizeWords(turn.say).join(' ');
      for (const term of turn.vocabulary) expect(words, `${turn.id} ${term}`).toContain(normalizeWords(term).join(' '));
    }
  });
});
