import { describe, expect, it } from 'vitest';
import { draftFieldSchema, MAX_AI_NOTE, MAX_SUMMARY, type DraftField } from '@/lib/field/schema';
import { acceptChanges, noteId, proposalNotes, summaryChanges, type SummaryProposal } from '@/lib/field/summary';
import { judgeMe } from '@/lib/field/sync-gate';

// The summary of findings on Check Scope and the technician's accept of an AI draft (S7-6): what
// each writes to the field map (v3). The writes themselves go through the field rules
// (tests/emu/rules/field-map-v3.test.ts) and the browser (tests/e2e/summary-draft.spec.ts).

const PROPOSAL: SummaryProposal['proposal'] = {
  summary: 'Category 2 water from the supply line reached the kitchen and the hall.',
  suggestions: ['Check the subfloor under the dishwasher.', 'Photograph the toe kick.'],
  unpriced_work: ['Replace the toe kick,\n8 linear feet.'],
  testing_advice: ['Test the joint compound for asbestos before cutting.'],
};

// What a write leaves in the field map: a null deletes the key.
function applied(stored: DraftField, changes: Record<string, unknown>): unknown {
  const next: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

describe('a save of the summary box', () => {
  it('writes a typed summary exactly as typed, as the technician’s own', () => {
    const text = '  Wet drywall in the hall.\nNo mold seen.  ';
    expect(summaryChanges(text, {}).changes).toEqual({ summary: text, summarySource: 'manual' });
  });

  it('keeps an accepted AI draft marked as AI when the technician edits it', () => {
    const stored: DraftField = { summary: 'AI words.', summarySource: 'ai' };
    expect(summaryChanges('AI words, checked.', stored).changes).toEqual({ summary: 'AI words, checked.' });
  });

  it('deletes the summary and its source when the box is emptied, and writes nothing when unchanged', () => {
    expect(summaryChanges('  ', { summary: 'Old.', summarySource: 'ai' }).changes).toEqual({ summary: null, summarySource: null });
    expect(summaryChanges('', {}).changes).toEqual({});
    expect(summaryChanges('Same.', { summary: 'Same.', summarySource: 'manual' }).changes).toEqual({});
  });

  it('refuses a summary longer than the field map holds', () => {
    const result = summaryChanges('s'.repeat(MAX_SUMMARY + 1), {});
    expect(result.changes).toEqual({});
    expect(result.errors.summary).toBeTruthy();
  });
});

describe('the technician’s accept of an AI draft', () => {
  it('writes the summary as edited, its source as AI and only the ticked notes, as the field map reads them', () => {
    const ticked = new Set([noteId('suggestions', 1), noteId('unpricedWork', 0)]);
    const { changes, errors } = acceptChanges('Edited by the technician.', PROPOSAL, ticked);
    expect(errors).toEqual({});
    expect(changes).toEqual({
      summary: 'Edited by the technician.',
      summarySource: 'ai',
      aiNotes: { suggestions: ['Photograph the toe kick.'], unpricedWork: ['Replace the toe kick, 8 linear feet.'] },
    });
    expect(draftFieldSchema.safeParse(applied({ yearBuilt: 1972 }, changes)).success).toBe(true);
  });

  it('removes the notes of an earlier accept when none are ticked', () => {
    const stored: DraftField = { summary: 'Old.', summarySource: 'ai', aiNotes: { suggestions: ['Old note.'] } };
    const { changes } = acceptChanges(PROPOSAL.summary, PROPOSAL, new Set());
    expect(changes).toEqual({ summary: PROPOSAL.summary, summarySource: 'ai', aiNotes: null });
    expect(applied(stored, changes)).toEqual({ summary: PROPOSAL.summary, summarySource: 'ai' });
  });

  it('refuses an empty summary and a ticked note the field map cannot hold, writing nothing', () => {
    expect(acceptChanges(' \n ', PROPOSAL, new Set())).toMatchObject({ changes: {}, errors: { summary: expect.any(String) } });
    const long = { ...PROPOSAL, suggestions: ['n'.repeat(MAX_AI_NOTE + 1)] };
    expect(acceptChanges(PROPOSAL.summary, long, new Set([noteId('suggestions', 0)]))).toMatchObject({ changes: {}, errors: { notes: expect.any(String) } });
  });

  it('offers each note on one line and leaves out empty ones', () => {
    expect(proposalNotes({ ...PROPOSAL, suggestions: ['  ', 'One\r\ntwo'] })).toEqual({
      suggestions: ['One two'],
      unpricedWork: ['Replace the toe kick, 8 linear feet.'],
      testingAdvice: ['Test the joint compound for asbestos before cutting.'],
    });
  });
});

describe('the AI summary switch in an /api/me answer', () => {
  const answer = (features: Record<string, unknown>) => ({
    status: 200,
    body: {
      company: { id: 'company-a', name: 'Company A' },
      actor: { id: 'actor-a', displayName: null },
      role: 'estimator',
      capabilities: ['scope', 'audit'],
      features,
      fieldAccessExpiresAt: new Date(Date.UTC(2026, 10, 22)).toISOString(),
    },
  });
  const now = Date.UTC(2026, 10, 21);

  it('opens "Draft with AI" only on an affirmative switch', () => {
    const on = judgeMe(answer({ ai_summary: true }), now);
    expect(on.kind === 'open' && on.facts.aiSummary).toBe(true);
    for (const value of [false, 'true', 1, undefined]) {
      const off = judgeMe(answer({ ai_summary: value }), now);
      expect(off.kind === 'open' && off.facts.aiSummary, String(value)).toBeUndefined();
    }
  });
});
