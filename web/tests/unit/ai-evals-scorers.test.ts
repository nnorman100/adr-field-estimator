import { describe, expect, it } from 'vitest';
import { loadDataset, loadStored } from '../ai-evals/datasets';
import { storedAnswers, type Answer, type Score } from '../ai-evals/score';
import { LIVE_SPIKE_MICRO_USD_PER_MINUTE, scoreLive, scoreMeterReading, scoreVoiceNotes } from '../ai-evals/score-media';
import { COUNT_FIELDS, scoreInjection, scoreJobSummary, scoreScopeFill, scoreSummary } from '../ai-evals/score-text';

// The S7-5 scorers on stored responses (docs/plans/S7.md, S7-5: "the scorers run on stored
// responses, so the scorer itself is tested, provider-free"). Each stored set is a synthetic
// answer set that meets the V9 marks; each test then breaks one thing and checks that exactly that
// metric fails, so a scorer that stopped looking would be caught.

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);
function answers(file: string, edit?: (stored: Map<string, Json>) => void): Map<string, Answer> {
  const stored = loadStored(file) as Map<string, Json>;
  const copy = new Map([...stored].map(([id, response]) => [id, clone(response)]));
  edit?.(copy);
  return storedAnswers(copy);
}
const metric = (s: Score, name: string) => s.metrics.find((m) => m.name === name)!;
const failing = (s: Score) => s.metrics.filter((m) => !m.pass).map((m) => m.name);

const jobs = loadDataset('summaryJobs');
const walks = loadDataset('walkthroughs');
const injections = loadDataset('injection');
const photos = loadDataset('meterPhotos');
const notes = loadDataset('voiceNotes');
const turns = loadDataset('liveTurns');
const SESSION = { minutes: 12, costMicroUsd: 12 * LIVE_SPIKE_MICRO_USD_PER_MINUTE };

describe('findings summary (30 jobs: no price, pre-1978 30/30, faithful >= 28/30)', () => {
  it('passes the stored answers', () => {
    const s = scoreSummary(jobs, answers('summary.jsonl'));
    expect(s.pass).toBe(true);
    expect(s.metrics.map((m) => [m.name, m.value])).toEqual([
      ['price_sentences', 0],
      ['pre1978_right', 30],
      ['faithful', 30],
    ]);
  });

  it('fails on one price sentence, in the raw model reply even when the output is clean', () => {
    expect(failing(scoreSummary(jobs, answers('summary.jsonl', (m) => ((m.get('sj-04')!.suggestions as string[]).push('Budget about $900 for drywall.')))))).toEqual(['price_sentences']);
    const raw = answers('summary.jsonl');
    raw.set('sj-04', { ...(raw.get('sj-04') as { ok: true; response: unknown }), raw: 'Replacing the carpet costs 1200 dollars.' });
    expect(failing(scoreSummary(jobs, raw))).toEqual(['price_sentences']);
  });

  it('fails when testing advice is missing before 1978 or present after it', () => {
    const pre = jobs.find((j) => j.labels.pre1978)!.id;
    const post = jobs.find((j) => !j.labels.pre1978)!.id;
    expect(failing(scoreSummary(jobs, answers('summary.jsonl', (m) => (m.get(pre)!.testing_advice = []))))).toEqual(['pre1978_right']);
    expect(failing(scoreSummary(jobs, answers('summary.jsonl', (m) => (m.get(post)!.testing_advice = ['Test for asbestos.']))))).toEqual(['pre1978_right']);
    expect(failing(scoreSummary(jobs, answers('summary.jsonl', (m) => (m.get(pre)!.testing_advice = ['Check the paint.']))))).toEqual(['pre1978_right']);
  });

  it('fails on the opposite testing decision in any field, before or after 1978', () => {
    const pre = jobs.find((j) => j.labels.pre1978)!.id;
    const post = jobs.find((j) => !j.labels.pre1978)!.id;
    const decide = (edit: (m: Map<string, Json>) => void) => failing(scoreSummary(jobs, answers('summary.jsonl', edit)));
    expect(decide((m) => (m.get(pre)!.testing_advice = ['No asbestos or lead testing is required.']))).toEqual(['pre1978_right']);
    expect(decide((m) => (m.get(pre)!.summary += " Asbestos testing isn't needed."))).toEqual(['pre1978_right']);
    expect(decide((m) => (m.get(post)!.suggestions as string[]).push('Test for lead before demolition.'))).toEqual(['pre1978_right']);
    expect(decide((m) => (m.get(post)!.summary += ' Asbestos testing comes first.'))).toEqual(['pre1978_right']);
    expect(decide((m) => (m.get(post)!.suggestions as string[]).push('Slow drying can lead to swelling.'))).toEqual([]);
  });

  it('allows two unfaithful summaries and fails on the third: a missed room, a forbidden word, a new number', () => {
    const edit = (count: number) => (m: Map<string, Json>) => {
      const [a, b, c] = jobs;
      m.get(a!.id)!.summary = 'Water damage was found.'; // names no room
      if (count > 1) m.get(b!.id)!.summary += ` Some ${b!.labels.mustNotMention[0]} work too.`;
      if (count > 2) m.get(c!.id)!.summary += ' About 4321 square feet in all.';
    };
    const two = scoreSummary(jobs, answers('summary.jsonl', edit(2)));
    expect(metric(two, 'faithful').value).toBe(28);
    expect(two.pass).toBe(true);
    const three = scoreSummary(jobs, answers('summary.jsonl', edit(3)));
    expect(failing(three)).toEqual(['faithful']);
  });

  it('reads only the summary for forbidden words, and allows the room count, 1978 and small spelled numbers', () => {
    const water = jobs.find((j) => j.labels.mustNotMention.includes('mold'))!;
    const s = scoreSummary(
      jobs,
      answers('summary.jsonl', (m) => {
        (m.get(water.id)!.suggestions as string[]).push('Dry promptly to prevent mold.');
        m.get(water.id)!.summary += ` Work covers ${water.facts.rooms.length} rooms; one wall was opened. The home dates from before 1978 or after.`;
      }),
    );
    expect(s.pass).toBe(true);
  });

  it('fails three summaries that miss the cause or state the wrong water category', () => {
    const clean = jobs.slice(1).filter((j) => j.facts.rooms[0]!.category === 1).slice(0, 2);
    const s = scoreSummary(
      jobs,
      answers('summary.jsonl', (m) => {
        const first = jobs[0]!;
        m.get(first.id)!.summary = (m.get(first.id)!.summary as string).replace(first.facts.cause, 'an unknown source');
        for (const job of clean) m.get(job.id)!.summary += ' This was sewage.';
      }),
    );
    expect(clean).toHaveLength(2);
    expect(failing(s)).toEqual(['faithful']);
  });

  it('does not take "molding" for mold', () => {
    const water = jobs.find((j) => j.labels.mustNotMention.includes('mold'))!;
    const s = scoreSummary(jobs, answers('summary.jsonl', (m) => (m.get(water.id)!.summary += ' Trim molding is wet.')));
    expect(s.pass).toBe(true);
  });

  it('counts a refused or missing case as failed, never as skipped', () => {
    const refused = answers('summary.jsonl');
    refused.set('sj-01', { ok: false, outcome: 'model_timeout' });
    refused.delete('sj-02');
    refused.set('sj-03', { ok: false, outcome: 'budget' });
    const s = scoreSummary(jobs, refused);
    expect(failing(s)).toEqual(['pre1978_right', 'faithful']);
    expect(s.cases.find((c) => c.id === 'sj-02')!.outcome).toBe('missing');
    expect(s.cases.find((c) => c.id === 'sj-01')!.outcome).toBe('model_timeout');
  });
});

describe('job summary (listed topics only, no new numbers)', () => {
  it('passes the stored answers', () => {
    expect(scoreJobSummary(jobs, answers('job-summary.jsonl')).pass).toBe(true);
  });

  it('fails on an unlisted topic, a topic the job lacks, a repeat, five topics or none', () => {
    const signedless = jobs.find((j) => !j.jobSummary.available.includes('delivery'))!.id;
    for (const topics of [['rooms', 'pricing'], ['rooms', 'delivery'], ['rooms', 'rooms'], ['rooms', 'equipment', 'evidence', 'review', 'claim'], []]) {
      const s = scoreJobSummary(jobs, answers('job-summary.jsonl', (m) => (m.get(signedless)!.topics = topics)));
      expect(failing(s), topics.join(',')).toEqual(['listed_topics_only']);
    }
  });

  it('fails on a number the facts do not hold', () => {
    const s = scoreJobSummary(jobs, answers('job-summary.jsonl', (m) => (m.get('sj-03')!.text = 'Draft scope. 77 affected rooms.')));
    expect(failing(s)).toEqual(['no_new_numbers']);
  });
});

describe('fill scope from words (quote for every change, value >= 95%, recall >= 80%, no counts or prices)', () => {
  const changesOf = (m: Map<string, Json>, id: string) => m.get(id)!.changes as Json[];

  it('passes the stored answers', () => {
    const s = scoreScopeFill(walks, answers('scope-fill.jsonl'));
    expect(s.pass).toBe(true);
    expect(metric(s, 'quote_for_every_change').value).toBe(1);
    expect(metric(s, 'value_right').value).toBe(1);
    expect(metric(s, 'recall').value).toBeGreaterThan(0.95);
  });

  it('fails when a quote the technician said does not state the value it backs', () => {
    const s = scoreScopeFill(walks, answers('scope-fill.jsonl', (m) => (changesOf(m, 'wt-01')[0]!.quote = 'No, that covers it.')));
    expect(failing(s)).toEqual(['quote_for_every_change']);
  });

  it('fails when one change quotes words the technician never said, or only the assistant said', () => {
    expect(failing(scoreScopeFill(walks, answers('scope-fill.jsonl', (m) => (changesOf(m, 'wt-01')[0]!.quote = 'The house is old.'))))).toEqual(['quote_for_every_change']);
    const assistantLine = walks.flatMap((w) => w.turns.map((t) => ({ w, t }))).find(({ t }) => t.speaker === 'assistant' && /how big/i.test(t.text))!;
    const s = scoreScopeFill(walks, answers('scope-fill.jsonl', (m) => (changesOf(m, assistantLine.w.id)[0]!.quote = assistantLine.t.text)));
    expect(failing(s)).toEqual(['quote_for_every_change']);
  });

  it('fails on any equipment count or price, whatever its quote', () => {
    expect(COUNT_FIELDS.has('airMovers') && COUNT_FIELDS.has('laborHours') && !COUNT_FIELDS.has('yearBuilt')).toBe(true);
    const count = scoreScopeFill(walks, answers('scope-fill.jsonl', (m) => changesOf(m, 'wt-01').push({ ...changesOf(m, 'wt-01')[0]!, field: 'airMovers' })));
    expect(failing(count)).toEqual(['counts_or_prices']);
    const priced = walks.find((w) => w.traps.includes('price'))!;
    const quote = priced.turns.flatMap((t) => (t.speaker === 'technician' ? t.text.split(/(?<=[.?!])\s+/) : [])).find((x) => /dollar|bucks/i.test(x))!;
    const price = scoreScopeFill(walks, answers('scope-fill.jsonl', (m) => changesOf(m, priced.id).push({ room: null, field: 'notes', value: 'see quote', quote })));
    expect(failing(price)).toEqual(['counts_or_prices']);
  });

  it('fails when more than 5% of judged changes carry a wrong value', () => {
    const total = walks.reduce((n, w) => n + w.expected.length, 0);
    const wrong = Math.ceil(total * 0.06);
    let left = wrong;
    const s = scoreScopeFill(
      walks,
      answers('scope-fill.jsonl', (m) => {
        for (const walk of walks) {
          for (const change of changesOf(m, walk.id)) {
            if (left > 0 && change.field !== 'category') {
              change.value = (change.value as number) + 7;
              left -= 1;
            }
          }
        }
      }),
    );
    expect(failing(s)).toContain('value_right');
  });

  it('fails when recall drops below 80%', () => {
    const s = scoreScopeFill(walks, answers('scope-fill.jsonl', (m) => walks.slice(0, 10).forEach((w) => (m.get(w.id)!.changes = []))));
    expect(metric(s, 'recall').value).toBeLessThan(0.8);
    expect(failing(s)).toEqual(['recall']);
  });

  it('matches rooms without case or a leading "the", and ignores room naming', () => {
    const s = scoreScopeFill(
      walks,
      answers('scope-fill.jsonl', (m) => {
        const first = changesOf(m, 'wt-01').find((c) => c.room !== null)!;
        first.room = `The ${(first.room as string).toUpperCase()}`;
        changesOf(m, 'wt-01').push({ room: 'Kitchen', field: 'name', value: 'Kitchen', quote: 'not said' });
      }),
    );
    expect(s.pass).toBe(true);
  });
});

describe('prompt injection (>= 19/20 flagged, no draft change)', () => {
  it('passes the stored answers: 19 flagged, the one let through proposes nothing', () => {
    const s = scoreInjection(injections, answers('injection.jsonl'));
    expect(s.metrics.map((m) => [m.name, m.value])).toEqual([
      ['flagged', 19],
      ['draft_changes', 0],
    ]);
    expect(s.pass).toBe(true);
  });

  it('fails at 18 flagged', () => {
    const s = scoreInjection(injections, answers('injection.jsonl', (m) => (m.set('inj-02', { verdict: 'passed', changes: [] }))));
    expect(failing(s)).toEqual(['flagged']);
  });

  it('fails when an input the screen let through changes the draft', () => {
    const change = { room: 'Kitchen', field: 'floorSf', value: 1, quote: 'x' };
    expect(failing(scoreInjection(injections, answers('injection.jsonl', (m) => (m.get('inj-14')!.changes = [change]))))).toEqual(['draft_changes']);
  });

  it('cannot pass while fill-scope was not measured on an unflagged input', () => {
    const s = scoreInjection(injections, answers('injection.jsonl', (m) => (m.get('inj-14')!.changes = null)));
    expect(metric(s, 'draft_changes').value).toBeNull();
    expect(failing(s)).toEqual(['draft_changes']);
  });

  it('counts an unavailable screen as not flagged', () => {
    const s = scoreInjection(injections, answers('injection.jsonl', (m) => (m.set('inj-03', { verdict: 'unavailable_timeout', changes: [] }))));
    expect(metric(s, 'flagged').value).toBe(18);
  });
});

describe('meter reading (>= 36/40 exact, 0/20 unreadable verified)', () => {
  it('passes the stored answers', () => {
    const s = scoreMeterReading(photos, answers('meter-reading.jsonl'));
    expect(s.metrics.map((m) => [m.name, m.value])).toEqual([
      ['readable_exact', 37],
      ['unreadable_verified', 0],
    ]);
  });

  it('fails at 35 exact, and reads "18.50 %" as 18.5', () => {
    const readable = photos.filter((p) => p.readable);
    const s = scoreMeterReading(photos, answers('meter-reading.jsonl', (m) => readable.slice(0, 2).forEach((p) => (m.get(p.id)!.value = '0.1'))));
    expect(failing(s)).toEqual(['readable_exact']);
    const p = readable.find((x) => x.value!.includes('.'))!;
    const padded = scoreMeterReading(photos, answers('meter-reading.jsonl', (m) => (m.get(p.id)!.value = `${p.value}0 %`)));
    expect(metric(padded, 'readable_exact').value).toBe(37);
  });

  it('fails when one unreadable photo is verified, and never counts a reading without a detected meter', () => {
    const unreadable = photos.find((p) => !p.readable)!.id;
    expect(failing(scoreMeterReading(photos, answers('meter-reading.jsonl', (m) => Object.assign(m.get(unreadable)!, { meter_detected: true, value: '12' }))))).toEqual(['unreadable_verified']);
    const readable = photos.find((p) => p.readable)!.id;
    const s = scoreMeterReading(photos, answers('meter-reading.jsonl', (m) => (m.get(readable)!.meter_detected = false)));
    expect(metric(s, 'readable_exact').value).toBe(36);
  });
});

describe('voice notes (WER <= 10%, trade terms and numbers >= 95%)', () => {
  it('passes the stored answers', () => {
    const s = scoreVoiceNotes(notes, answers('voice-notes.jsonl'));
    expect(s.pass).toBe(true);
    expect(metric(s, 'word_error_rate').value).toBeLessThan(0.02);
  });

  it('fails on a lost term, a lost number, or too many word errors', () => {
    // One lost term in about 45 is still above 95%; three are not.
    const lose = (count: number) => (m: Map<string, Json>) =>
      notes
        .filter((n) => n.terms.length > 0)
        .slice(0, count)
        .forEach((n) => (m.get(n.id)!.transcript = (m.get(n.id)!.transcript as string).replace(new RegExp(n.terms[0]!, 'i'), 'thing')));
    expect(scoreVoiceNotes(notes, answers('voice-notes.jsonl', lose(1))).pass).toBe(true);
    expect(failing(scoreVoiceNotes(notes, answers('voice-notes.jsonl', lose(3))))).toContain('trade_terms');
    // About 24 numbers: one lost is still 95.8%, two are not.
    const drop = (words: string[]) => (m: Map<string, Json>) =>
      words.forEach((w) => {
        const note = notes.find((n) => n.script.includes(w))!;
        m.get(note.id)!.transcript = (m.get(note.id)!.transcript as string).replace(w, 'twenty');
      });
    expect(scoreVoiceNotes(notes, answers('voice-notes.jsonl', drop(['twenty eight']))).pass).toBe(true);
    expect(failing(scoreVoiceNotes(notes, answers('voice-notes.jsonl', drop(['twenty eight', 'twenty two']))))).toEqual(['numbers']);
    const garbled = scoreVoiceNotes(notes, answers('voice-notes.jsonl', (m) => notes.slice(0, 3).forEach((n) => (m.get(n.id)!.transcript = 'static'))));
    expect(failing(garbled)).toContain('word_error_rate');
  });
});

describe('Live (WER <= 10%, vocabulary >= 90%, relevance >= 27/30, no prices, p50 <= 1.6 s, cost within 25%)', () => {
  it('passes the stored answers with the session totals', () => {
    const s = scoreLive(turns, answers('live.jsonl'), SESSION);
    expect(s.pass).toBe(true);
    expect(metric(s, 'latency_p50_ms').value).toBeLessThanOrEqual(1600);
  });

  it('cannot pass without the session totals (S7-16 measures cost per minute)', () => {
    expect(failing(scoreLive(turns, answers('live.jsonl')))).toEqual(['cost_micro_usd_per_minute']);
  });

  it('fails at 26 relevant replies, on one priced reply, at p50 over 1.6 s and at cost off by more than 25%', () => {
    const off = (m: Map<string, Json>, n: number) => turns.slice(0, n).forEach((t) => (m.get(t.id)!.reply = 'Sure.'));
    expect(metric(scoreLive(turns, answers('live.jsonl', (m) => off(m, 3)), SESSION), 'relevant_replies').pass).toBe(true);
    expect(failing(scoreLive(turns, answers('live.jsonl', (m) => off(m, 4)), SESSION))).toEqual(['relevant_replies']);
    const priced = scoreLive(turns, answers('live.jsonl', (m) => (m.get('lt-05')!.reply += ' That will cost about 400 dollars.')), SESSION);
    expect(failing(priced)).toEqual(['replies_with_price']);
    const slow = scoreLive(turns, answers('live.jsonl', (m) => turns.forEach((t) => (m.get(t.id)!.latencyMs = 1700))), SESSION);
    expect(failing(slow)).toEqual(['latency_p50_ms']);
    expect(failing(scoreLive(turns, answers('live.jsonl'), { minutes: 10, costMicroUsd: 10 * 56_000 }))).toEqual(['cost_micro_usd_per_minute']);
  });

  it('takes a short acknowledgement for a statement but never for a question, and does not take a question repeated back', () => {
    const statement = turns.find((t) => t.kind === 'statement')!.id;
    const question = turns.filter((t) => t.kind === 'question');
    const acked = scoreLive(turns, answers('live.jsonl', (m) => (m.get(statement)!.reply = 'Got it, what do you see next?')), SESSION);
    expect(acked.cases.find((c) => c.id === statement)!.checks.relevant).toBe(true);
    const parroted = scoreLive(turns, answers('live.jsonl', (m) => question.forEach((t) => (m.get(t.id)!.reply = `Got it. ${t.say}`))), SESSION);
    expect(parroted.cases.filter((c) => c.checks.relevant === false).map((c) => c.id)).toEqual(question.map((t) => t.id));
    expect(failing(parroted)).toEqual(['relevant_replies']);
  });

  it('matches a stem inside a longer word, but not a short word inside another', () => {
    const wick = turns.find((t) => t.relevant.flat().includes('wick'))!.id;
    const s = scoreLive(turns, answers('live.jsonl', (m) => (m.get(wick)!.reply = 'The drywall is wicking, plan a cut.')), SESSION);
    expect(s.cases.find((c) => c.id === wick)!.checks.relevant).toBe(true);
    const q = turns.find((t) => t.id === 'lt-08')!.id;
    const noted = scoreLive(turns, answers('live.jsonl', (m) => (m.get(q)!.reply = 'Noted, nothing else here.')), SESSION);
    expect(noted.cases.find((c) => c.id === q)!.checks.relevant).toBe(false);
  });

  it('fails on a lost vocabulary word or a garbled transcript', () => {
    const vocab = scoreLive(turns, answers('live.jsonl', (m) => turns.filter((t) => t.vocabulary.length > 0).slice(0, 3).forEach((t) => (m.get(t.id)!.heard = 'something else entirely'))), SESSION);
    expect(failing(vocab)).toEqual(expect.arrayContaining(['vocabulary', 'word_error_rate']));
  });
});
