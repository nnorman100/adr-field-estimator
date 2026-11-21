'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { draftSummaryWithAi } from '@/lib/field/api';
import { MAX_SUMMARY } from '@/lib/field/schema';
import { draftFieldWrites, type FieldDraft } from '@/lib/field/store';
import { acceptChanges, NOTE_LISTS, noteId, proposalNotes, summaryChanges, type SummaryProposal } from '@/lib/field/summary';
import type { JobContext } from './job-screens';
import { Outcome, READ_AGAIN, Section } from './ui';
import { useFieldEdit } from './use-field-edit';

const TEXTAREA = 'w-full rounded-md border border-foreground/40 bg-background p-3 text-base read-only:bg-foreground/5';

// An AI draft on screen: the proposal as the server answered it, the summary as the technician is
// editing it in the review box, and the notes they ticked.
type Review = { answer: SummaryProposal; summary: string; ticked: ReadonlySet<string> };

// The summary of findings on Check Scope (owner decision J1) and "Draft with AI" beside it (S7-6).
// The technician types the summary, or asks for an AI draft: the proposal shows under an "AI draft,
// check it" label, where they edit, accept or discard it, and tick the suggestions, unpriced work
// and testing advice to keep. Nothing of a proposal reaches the field draft until they press Accept
// (src/lib/field/summary.ts acceptChanges); the route that drafts it never writes the draft.
// "Draft with AI" shows only while the company's `ai_summary` switch is on (live /api/me), for the
// draft's field owner with the `audit` capability, and needs a signal.
export function SummarySection({ job, draft }: { job: JobContext; draft: FieldDraft }) {
  const stored = draft.field;
  const [edit, setEdit] = useState<string | null>(null);
  const text = edit ?? stored.summary ?? '';
  const [error, setFormError] = useState<string | null>(null);
  const { busy, error: saveError, notice, setError, setNotice, save } = useFieldEdit(job);
  const [review, setReview] = useState<Review | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The call id of a request that got no answer: sent again, it finds the same proposal. Any answer
  // from the server ends it, so the next request is a new call.
  const unanswered = useRef<string | null>(null);
  // Only the newest request, made for this job and draft while this section is on screen, may answer.
  const latest = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  // While an allowance refusal says to wait, the button stays off until that time.
  useEffect(() => {
    if (waitUntil === null) return;
    const left = waitUntil - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(left, 60_000));
    return () => clearTimeout(timer);
  }, [waitUntil, now]);

  const readOnly = !job.editable;
  const { markUnsaved } = job;
  const unsaved = (edit !== null && summaryChanges(edit, stored).changes.summary !== undefined) || review !== null;
  useLayoutEffect(() => {
    markUnsaved('summary', unsaved ? () => {
      setEdit(null);
      setReview(null);
    } : null);
    return () => markUnsaved('summary', null);
  }, [markUnsaved, unsaved]);

  const canAsk = job.session.aiSummary && job.session.capabilities.includes('audit') && !readOnly;
  const waiting = waitUntil !== null && waitUntil > now;

  async function saveSummary() {
    if (job.stale) return;
    const { changes, errors } = summaryChanges(text, stored);
    setFormError(errors.summary ?? null);
    setNotice(null);
    if (errors.summary) return;
    setError(null);
    if (Object.keys(changes).length === 0) return setNotice('Nothing to save.');
    const sent = edit;
    await save(draftFieldWrites(job.draftRef, changes), 'Summary saved.', () => {
      setEdit((current) => (current === sent ? null : current));
    });
  }

  async function ask() {
    if (!job.session.online || waiting) return;
    const callId = unanswered.current ?? crypto.randomUUID();
    unanswered.current = callId;
    const mine = ++latest.current;
    const { jobId } = job;
    const { draftId } = job.draftRef;
    setAsking(true);
    setAskError(null);
    const answer = await draftSummaryWithAi(job.session.user, jobId, callId);
    if (!live.current || mine !== latest.current) return;
    setAsking(false);
    if (!answer.ok && answer.status === 0) {
      setAskError(answer.message);
      return;
    }
    unanswered.current = null;
    if (!answer.ok) {
      if (!answer.code?.startsWith('ai_')) job.checkAccess({ status: answer.status, message: answer.message });
      setAskError(answer.message);
      if (answer.retryAfterSeconds) {
        setNow(Date.now());
        setWaitUntil(Date.now() + answer.retryAfterSeconds * 1000);
      }
      return;
    }
    // A proposal for another job or draft than the one on screen now is not this draft's.
    if (answer.value.jobId !== jobId || answer.value.draftId !== draftId || job.draftRef.draftId !== draftId) {
      setAskError('This job’s draft changed while the AI draft was made. Ask again.');
      return;
    }
    setReview({ answer: answer.value, summary: answer.value.proposal.summary, ticked: new Set() });
  }

  async function accept() {
    if (!review || job.stale) return;
    const { changes, errors } = acceptChanges(review.summary, review.answer.proposal, review.ticked, stored.aiNotes ?? {});
    const found = errors.summary ?? errors.notes ?? null;
    setFormError(found);
    setNotice(null);
    if (found) return;
    setError(null);
    const reviewed = review;
    const sent = edit;
    await save(draftFieldWrites(job.draftRef, changes), 'Summary saved.', () => {
      setReview((current) => (current === reviewed ? null : current));
      setEdit((current) => (current === sent ? null : current));
    });
  }

  function discard() {
    setReview(null);
    setFormError(null);
    setNotice('AI draft discarded. Nothing was saved from it.');
  }

  const notes = review ? proposalNotes(review.answer.proposal) : null;
  const acceptedNotes = stored.aiNotes ?? {};
  const acceptedLists = NOTE_LISTS.filter(({ key }) => (acceptedNotes[key] ?? []).length > 0);

  return (
    <Section title="Summary of findings">
      <form
        className="flex flex-col gap-3"
        aria-label="Summary"
        onSubmit={(event) => {
          event.preventDefault();
          void saveSummary();
        }}
      >
        <label htmlFor="fact-summary" className="text-sm font-medium">
          Summary of findings
        </label>
        <p id="fact-summary-hint" className="text-sm">
          {stored.summarySource === 'ai'
            ? 'Drafted with AI and accepted. The documents print it.'
            : 'What you found on site, in your words. The documents print it. It is separate from the notes.'}
        </p>
        <textarea
          id="fact-summary"
          rows={6}
          maxLength={MAX_SUMMARY}
          readOnly={readOnly}
          aria-describedby="fact-summary-hint"
          value={text}
          onChange={(event) => {
            setEdit(event.target.value);
            setNotice(null);
          }}
          className={TEXTAREA}
        />
        {readOnly ? null : (
          <Button type="submit" disabled={busy || job.stale}>
            {busy ? 'Saving…' : 'Save summary'}
          </Button>
        )}
      </form>
      {acceptedLists.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-base font-semibold">Accepted AI notes</h4>
          {acceptedLists.map(({ key, title }) => (
            <div key={key}>
              <p className="text-sm font-medium">{title}</p>
              <ul className="list-disc pl-5 text-base">
                {(acceptedNotes[key] ?? []).map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      {canAsk && !review ? (
        <div className="flex flex-col gap-1">
          <Button type="button" variant="outline" disabled={asking || waiting || !job.session.online || job.stale} onClick={() => void ask()}>
            {asking ? 'Drafting…' : 'Draft with AI'}
          </Button>
          {!job.session.online ? <p className="text-sm">Draft with AI needs a signal.</p> : null}
          {waiting && waitUntil !== null ? (
            <p className="text-sm">Draft with AI can be asked again after {new Date(waitUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
          ) : null}
          <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
            {askError ?? ''}
          </p>
        </div>
      ) : null}
      {review && notes ? (
        <section aria-labelledby="ai-draft-heading" className="flex flex-col gap-3 rounded-md border-2 border-amber-700 p-3">
          <h4 id="ai-draft-heading" className="text-base font-semibold">
            AI draft, check it
          </h4>
          <p className="text-sm">Nothing is saved until you press Accept. Edit the summary and tick the notes to keep.</p>
          {stored.summary ? <p className="text-sm">Accepting replaces the summary saved now.</p> : null}
          <label htmlFor="ai-summary" className="text-sm font-medium">
            Drafted summary
          </label>
          <textarea
            id="ai-summary"
            rows={8}
            maxLength={MAX_SUMMARY}
            value={review.summary}
            readOnly={readOnly}
            onChange={(event) => {
              const summary = event.target.value;
              setReview((current) => (current ? { ...current, summary } : current));
            }}
            className={TEXTAREA}
          />
          {NOTE_LISTS.filter(({ key }) => notes[key].length > 0).map(({ key, title }) => (
            <fieldset key={key} className="flex flex-col gap-1">
              <legend className="text-sm font-medium">{title}</legend>
              {notes[key].map((note, index) => {
                const id = noteId(key, index);
                return (
                  <div key={id} className="flex min-h-11 items-start gap-3 py-1">
                    <input
                      id={`ai-note-${id}`}
                      type="checkbox"
                      className="mt-0.5 size-6 shrink-0"
                      checked={review.ticked.has(id)}
                      disabled={readOnly}
                      onChange={(event) => {
                        const on = event.target.checked;
                        setReview((current) => {
                          if (!current) return current;
                          const ticked = new Set(current.ticked);
                          if (on) ticked.add(id);
                          else ticked.delete(id);
                          return { ...current, ticked };
                        });
                      }}
                    />
                    <label htmlFor={`ai-note-${id}`} className="min-w-0 text-base break-words">
                      {note}
                    </label>
                  </div>
                );
              })}
            </fieldset>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" disabled={busy || job.stale || readOnly} onClick={() => void accept()}>
              Accept
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={discard}>
              Discard
            </Button>
          </div>
        </section>
      ) : null}
      {!readOnly && job.stale ? <p className="text-sm">{READ_AGAIN}</p> : null}
      <Outcome error={error ?? saveError} notice={notice} />
    </Section>
  );
}
