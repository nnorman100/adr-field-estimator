'use client';

import { useLayoutEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  CHARGE_FIELDS,
  CONFIRMED_FIELD,
  editsAfterSave,
  EQUIPMENT_FIELDS,
  editedResult,
  factChanges,
  FACT_FIELDS,
  NOTES_FIELD,
  withEdits,
  YEAR_FIELD,
  type FormField,
  type FormValues,
} from '@/lib/field/forms';
import { MAX_NOTES } from '@/lib/field/schema';
import { draftFieldWrites, type FieldDraft } from '@/lib/field/store';
import { markerText } from '@/lib/readiness/client';
import { readinessMarker } from '@/lib/readiness/marker';
import { EquipmentSuggestion } from './equipment-suggestion';
import type { JobContext } from './job-screens';
import { PublishedItemList } from './published-item-list';
import { RoomsSection } from './rooms-section';
import { useFieldEdit } from './use-field-edit';
import { Box, Outcome, READ_AGAIN, Section, Tick } from './ui';

// Check Scope (S5a-6, room inputs S5a-10): year built, the rooms, equipment counts (with the counts
// the rooms suggest), job charges, notes and the
// scope-confirmed box, written straight to the job's field draft. The boxes hold only what the
// person changed over the draft as last read; Save writes only those, and the screen then reads the
// draft back, so a save never writes back a value someone else has since changed. The
// pre-1978 wording itself comes from the server with the estimate (S5a-9), never from here.
export function ScopeView({ job, draft, open, readinessFix }: { job: JobContext; draft: FieldDraft; open: boolean; readinessFix: string | null }) {
  // Only the boxes the person changed; the rest always show the draft as last read.
  const [edits, setEdits] = useState<FormValues>({});
  const values = withEdits(FACT_FIELDS, draft.field, edits);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, notice, setError, setNotice, save: saveEdit } = useFieldEdit(job);
  const readOnly = !job.editable;
  const row = job.detail?.job;
  const { checking, answer } = job.readiness;
  const marker = checking && row ? readinessMarker(row, answer, job.session.capabilities) : null;
  const { markUnsaved } = job;
  const result = factChanges(values, draft.field);
  const unsaved = editedResult(result, edits);
  useLayoutEffect(() => {
    markUnsaved('scope', unsaved ? () => {
      setEdits({});
      setErrors({});
    } : null);
    return () => markUnsaved('scope', null);
  }, [markUnsaved, unsaved]);
  const set = (key: string) => (value: string | boolean) => {
    setEdits((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };

  async function save() {
    if (job.stale) return;
    const { changes, errors: found } = result;
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) return setError('Check the boxes marked below.');
    setError(null);
    const sent = edits;
    if (Object.keys(changes).length === 0) return setNotice('Nothing to save.');
    await saveEdit(draftFieldWrites(job.draftRef, changes), 'Scope saved.', () => {
      setEdits((current) => editsAfterSave(current, sent));
    });
  }

  const box = (field: FormField<string>) =>
    field.kind === 'bool' ? (
      <Tick key={field.key} id={`fact-${field.key}`} label={field.label} checked={values[field.key] === true} onChange={set(field.key)} readOnly={readOnly} />
    ) : (
      <Box
        key={field.key}
        id={`fact-${field.key}`}
        label={field.label}
        value={String(values[field.key] ?? '')}
        onChange={set(field.key)}
        readOnly={readOnly}
        error={errors[field.key]}
        hint={field.hint}
        inputMode={field.kind === 'int' ? 'numeric' : 'decimal'}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <h3 id="readiness-scope" tabIndex={-1} className="sr-only focus:not-sr-only focus:text-lg focus:font-semibold">Check Scope</h3>
      {checking ? (
        <p role="status" className="text-sm empty:hidden">
          {marker ? markerText(marker) : answer !== undefined ? 'Readiness check unavailable.' : ''}
        </p>
      ) : null}
      {readinessFix === 'readiness-findings' ? (
        <p id="readiness-findings" tabIndex={-1} className="text-sm">The summary of findings is separate from job notes. Ask your company for help adding it.</p>
      ) : null}
      {open ? <PublishedItemList session={job.session} /> : null}
      {box(YEAR_FIELD)}
      <RoomsSection job={job} draft={draft} />
      <form
        className="flex flex-col gap-4"
        aria-label="Job scope"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Section title="Equipment">
          <EquipmentSuggestion draft={draft} />
          <div className="grid grid-cols-2 gap-3">{EQUIPMENT_FIELDS.map(box)}</div>
        </Section>
        <Section title="Job charges">
          <div className="grid grid-cols-2 gap-3">{CHARGE_FIELDS.filter((field) => field.kind !== 'bool').map(box)}</div>
          {CHARGE_FIELDS.filter((field) => field.kind === 'bool').map(box)}
        </Section>
        <Section title="Notes">
          <label htmlFor="fact-notes" className="sr-only">
            {NOTES_FIELD.label}
          </label>
          <textarea
            id="fact-notes"
            rows={5}
            maxLength={MAX_NOTES}
            readOnly={readOnly}
            value={String(values.notes ?? '')}
            onChange={(event) => set('notes')(event.target.value)}
            className="w-full rounded-md border border-foreground/40 bg-background p-3 text-base read-only:bg-foreground/5"
          />
        </Section>
        {box(CONFIRMED_FIELD)}
        {readOnly ? null : (
          <Button type="submit" disabled={busy || job.stale}>
            {busy ? 'Saving…' : 'Save scope'}
          </Button>
        )}
        {!readOnly && job.stale ? <p className="text-sm">{READ_AGAIN}</p> : null}
        <Outcome error={error} notice={notice} />
      </form>
    </div>
  );
}
