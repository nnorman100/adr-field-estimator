'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  CHARGE_FIELDS,
  CONFIRMED_FIELD,
  EQUIPMENT_FIELDS,
  factChanges,
  FACT_FIELDS,
  formOf,
  NOTES_FIELD,
  YEAR_FIELD,
  type FormField,
  type FormValues,
} from '@/lib/field/forms';
import { MAX_NOTES } from '@/lib/field/schema';
import { saveDraftField, type FieldDraft } from '@/lib/field/store';
import type { JobContext } from './job-screens';
import { RoomsSection } from './rooms-section';
import { Box, Outcome, Section, Tick } from './ui';

// Check Scope (S5a-6): year built, the rooms, equipment counts, job charges, notes and the
// scope-confirmed box, written straight to the job's field draft. The boxes keep what was typed;
// Save writes only the boxes that changed, and the screen then reads the draft back. The
// pre-1978 wording itself comes from the server with the estimate (S5a-9), never from here.
export function ScopeView({ job, draft }: { job: JobContext; draft: FieldDraft }) {
  const [values, setValues] = useState<FormValues>(() => formOf(FACT_FIELDS, draft.field));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const readOnly = !job.editable;
  const set = (key: string) => (value: string | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };

  async function save() {
    const db = job.session.db;
    if (!db) return;
    const { changes, errors: found } = factChanges(values, draft.field);
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) return setError('Check the boxes marked below.');
    setError(null);
    setBusy(true);
    try {
      await saveDraftField(db, job.draftRef, changes);
      await job.reloadDraft();
      setNotice(Object.keys(changes).length === 0 ? 'Nothing to save.' : 'Scope saved.');
    } catch {
      setError('The scope was not saved. Check the signal and save again.');
    } finally {
      setBusy(false);
    }
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
      <h3 className="sr-only">Check Scope</h3>
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
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save scope'}
          </Button>
        )}
        <Outcome error={error} notice={notice} />
      </form>
    </div>
  );
}
