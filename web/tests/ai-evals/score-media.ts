import { z } from 'zod';
import { statesPrice } from '../../src/lib/ai/rules';
import type { LiveTurn, MeterPhoto, VoiceNote } from './datasets';
import {
  atLeast,
  atMost,
  responseFor,
  score,
  shareAtLeast,
  valueAtMost,
  withinShare,
  type Answers,
  type CaseScore,
  type Score,
} from './score';
import { hasPhrase, median, normalizeWords, numberOf, numbersIn, wordErrorRate } from './text';

// Scorers for the audio and image features (V9 A, docs/plans/S7.md section 8): meter reading
// (S7-8), voice notes (S7-9) and the Live walkthrough (S7-16).

// ---- Meter reading: at least 36 of 40 readable photos read exactly; 0 of 20 unreadable photos
// verified. A reading is verified only when a meter was detected and a value was read (S7-8).
export const meterOutput = z.object({
  meter_detected: z.boolean(),
  value: z.union([z.string(), z.number()]).nullable(),
});

export function scoreMeterReading(cases: readonly MeterPhoto[], answers: Answers): Score {
  let exact = 0;
  let verifiedUnreadable = 0;
  const readable = cases.filter((photo) => photo.readable).length;
  const scored: CaseScore[] = cases.map((photo) => {
    const answer = responseFor(answers, photo.id, meterOutput);
    if (!answer.ok) return { id: photo.id, outcome: answer.outcome, checks: { exact: false, verified: false } };
    const { meter_detected, value } = answer.response;
    const verified = meter_detected && value !== null && String(value).trim().length > 0;
    if (photo.readable) {
      const isExact = verified && numberOf(value) !== null && numberOf(value) === numberOf(photo.value);
      if (isExact) exact += 1;
      return { id: photo.id, outcome: 'ok', checks: { exact: isExact, verified } };
    }
    if (verified) verifiedUnreadable += 1;
    return { id: photo.id, outcome: 'ok', checks: { exact: null, verified } };
  });
  return score(
    [
      atLeast('readable_exact', exact, readable, 36),
      atMost('unreadable_verified', verifiedUnreadable, cases.length - readable, 0),
    ],
    scored,
  );
}

// Shared by voice notes and Live: how many listed terms and numbers the transcript kept.
function kept(hypothesis: string, terms: readonly string[], numbers: readonly string[]) {
  const heardNumbers = numbersIn(hypothesis);
  return {
    terms: terms.filter((term) => hasPhrase(hypothesis, term)).length,
    numbers: numbers.filter((n) => heardNumbers.has(String(Number(n)))).length,
  };
}

// ---- Voice notes: word error rate at most 10%; trade terms and numbers each at least 95% kept.
// A note with no transcript counts as all words lost.
export const voiceOutput = z.object({ transcript: z.string() });

export function scoreVoiceNotes(cases: readonly VoiceNote[], answers: Answers): Score {
  const pairs: { reference: string; hypothesis: string }[] = [];
  let terms = 0;
  let termsKept = 0;
  let numbers = 0;
  let numbersKept = 0;
  const scored: CaseScore[] = cases.map((note) => {
    const answer = responseFor(answers, note.id, voiceOutput);
    const hypothesis = answer.ok ? answer.response.transcript : '';
    pairs.push({ reference: note.script, hypothesis });
    const k = kept(hypothesis, note.terms, note.numbers);
    terms += note.terms.length;
    termsKept += k.terms;
    numbers += note.numbers.length;
    numbersKept += k.numbers;
    return {
      id: note.id,
      outcome: answer.ok ? 'ok' : answer.outcome,
      checks: {
        wer: Math.round(wordErrorRate([{ reference: note.script, hypothesis }]) * 10_000) / 10_000,
        terms_kept: k.terms,
        numbers_kept: k.numbers,
      },
    };
  });
  return score(
    [
      valueAtMost('word_error_rate', wordErrorRate(pairs), 0.1),
      shareAtLeast('trade_terms', termsKept, terms, 0.95),
      shareAtLeast('numbers', numbersKept, numbers, 0.95),
    ],
    scored,
  );
}

// ---- Live: word error rate at most 10%; vocabulary at least 90%; a relevant reply in at least 27
// of 30 turns; no price in any reply; latency p50 at most 1.6 s; cost per minute within 25% of the
// spike's measured $0.044 a minute (docs/plans/S7.md section 12), in micro-USD.
export const LIVE_SPIKE_MICRO_USD_PER_MINUTE = 44_000;
export const liveOutput = z.object({ heard: z.string(), reply: z.string(), latencyMs: z.number().nonnegative() });
// The session totals the relay reports for the whole scripted walk (S7-16); undefined: not measured.
export type LiveSession = { minutes: number; costMicroUsd: number };

export function scoreLive(cases: readonly LiveTurn[], answers: Answers, session?: LiveSession): Score {
  const pairs: { reference: string; hypothesis: string }[] = [];
  const latencies: number[] = [];
  let vocabulary = 0;
  let vocabularyKept = 0;
  let relevant = 0;
  let priced = 0;
  const scored: CaseScore[] = cases.map((turn) => {
    const answer = responseFor(answers, turn.id, liveOutput);
    const heard = answer.ok ? answer.response.heard : '';
    const reply = answer.ok ? answer.response.reply : '';
    pairs.push({ reference: turn.say, hypothesis: heard });
    vocabulary += turn.vocabulary.length;
    const k = kept(heard, turn.vocabulary, []);
    vocabularyKept += k.terms;
    const replyWords = normalizeWords(reply).join(' ');
    const isRelevant =
      replyWords.length > 0 &&
      turn.relevant.every((group) => group.some((word) => hasPhrase(replyWords, word)));
    const price = statesPrice(reply);
    if (isRelevant) relevant += 1;
    if (price) priced += 1;
    if (answer.ok) latencies.push(answer.response.latencyMs);
    return {
      id: turn.id,
      outcome: answer.ok ? 'ok' : answer.outcome,
      checks: { relevant: isRelevant, price, latency_ms: answer.ok ? answer.response.latencyMs : null },
    };
  });
  const n = cases.length;
  const perMinute = session && session.minutes > 0 ? session.costMicroUsd / session.minutes : null;
  // Latency over turns that answered; with any turn missing the p50 is not measured.
  const p50 = latencies.length === n ? median(latencies) : null;
  return score(
    [
      valueAtMost('word_error_rate', wordErrorRate(pairs), 0.1),
      shareAtLeast('vocabulary', vocabularyKept, vocabulary, 0.9),
      atLeast('relevant_replies', relevant, n, 27),
      atMost('replies_with_price', priced, n, 0),
      valueAtMost('latency_p50_ms', p50, 1600),
      withinShare('cost_micro_usd_per_minute', perMinute, LIVE_SPIKE_MICRO_USD_PER_MINUTE, 0.25),
    ],
    scored,
  );
}
