// The Check Scope forms (S5a-6) on field map v1 (./schema.ts). A form holds what the technician
// typed, as text; these turn it into the keys to write, checked by the same Zod schema the server
// and the rules follow, so the phone never sends a value the rules would refuse. An empty box
// clears its value: the key is deleted, never written as null or zero.
import type { z } from 'zod';
import { draftFieldSchema, roomFieldSchema, type DraftField, type RoomField } from './schema';

type Kind = 'int' | 'decimal' | 'text' | 'bool';
export type FormField<K extends string> = { key: K; label: string; kind: Kind; hint?: string };

type FactKey = Exclude<keyof DraftField, 'roomOrder' | 'summary'>;
type RoomKey = keyof RoomField;

// The pre-1978 wording is the server's (src/engine/), so the phone says nothing about it here.
export const YEAR_FIELD: FormField<FactKey> = { key: 'yearBuilt', label: 'Year built', kind: 'int' };

export const EQUIPMENT_FIELDS: FormField<FactKey>[] = [
  { key: 'airMovers', label: 'Air movers', kind: 'int' },
  { key: 'dehumidifiers', label: 'Dehumidifiers', kind: 'int' },
  { key: 'airScrubbers', label: 'Air scrubbers', kind: 'int' },
  { key: 'dryingDays', label: 'Drying days', kind: 'int' },
  { key: 'woodFloorSystems', label: 'Wood floor drying systems', kind: 'int' },
  { key: 'woodFloorDays', label: 'Wood floor drying days', kind: 'int' },
];

export const CHARGE_FIELDS: FormField<FactKey>[] = [
  { key: 'emergencyCalls', label: 'Emergency calls', kind: 'int' },
  { key: 'monitoringHours', label: 'Monitoring hours', kind: 'decimal' },
  { key: 'laborHours', label: 'Labor hours', kind: 'decimal' },
  { key: 'haulLoads', label: 'Haul-away loads', kind: 'int' },
  { key: 'dumpTruckLoads', label: 'Dump truck loads', kind: 'int' },
  { key: 'hepaFilters', label: 'HEPA filters', kind: 'int' },
  { key: 'matterportScans', label: 'Matterport scans', kind: 'int' },
  { key: 'equipmentDecon', label: 'Equipment decontamination', kind: 'int' },
  { key: 'powerDistribution', label: 'Power distribution boxes', kind: 'int' },
  { key: 'isAfterHours', label: 'After-hours call', kind: 'bool' },
];

export const NOTES_FIELD: FormField<FactKey> = { key: 'notes', label: 'Notes', kind: 'text' };
export const CONFIRMED_FIELD: FormField<FactKey> = {
  key: 'scopeConfirmed',
  label: 'I checked this scope on site',
  kind: 'bool',
};

export const FACT_FIELDS: FormField<FactKey>[] = [YEAR_FIELD, ...EQUIPMENT_FIELDS, ...CHARGE_FIELDS, NOTES_FIELD, CONFIRMED_FIELD];

export const ROOM_FIELDS: FormField<RoomKey>[] = [
  { key: 'name', label: 'Room name', kind: 'text' },
  { key: 'category', label: 'Water category', kind: 'int' },
  { key: 'floorSf', label: 'Floor area (sq ft)', kind: 'decimal' },
  { key: 'wetFloorSf', label: 'Wet floor area (sq ft)', kind: 'decimal' },
  { key: 'finishedSf', label: 'Finished wall area (sq ft)', kind: 'decimal' },
  { key: 'unfinishedSf', label: 'Unfinished wall area (sq ft)', kind: 'decimal' },
  { key: 'wastePercent', label: 'Waste (%)', kind: 'decimal' },
];

export type FormValues = Record<string, string | boolean>;
// The keys to write: a value to set, or null to delete the key.
export type FieldChanges = Record<string, string | number | boolean | null>;
export type FormResult = { changes: FieldChanges; errors: Record<string, string> };

const NUMBER = /^\d+(\.\d+)?$/;

// What a box shows for a stored value.
export function formOf<K extends string>(fields: FormField<K>[], stored: Partial<Record<K, unknown>>): FormValues {
  const values: FormValues = {};
  for (const { key, kind } of fields) {
    const value = stored[key];
    values[key] = kind === 'bool' ? value === true : value === undefined || value === null ? '' : String(value);
  }
  return values;
}

function parseBox(kind: Kind, raw: string | boolean): { value: string | number | boolean | null } | { error: string } {
  if (kind === 'bool') return { value: raw === true ? true : null };
  const text = String(raw).trim();
  if (text === '') return { value: null };
  if (kind === 'text') return { value: text };
  if (!NUMBER.test(text)) return { error: kind === 'int' ? 'Enter a whole number.' : 'Enter a number.' };
  return { value: Number(text) };
}

// Only the boxes that changed from `stored`, each checked by `schema`'s rule for its key.
function changesOf<K extends string>(
  fields: FormField<K>[],
  schema: { shape: Record<string, z.ZodType> },
  values: FormValues,
  stored: Partial<Record<K, unknown>>,
): FormResult {
  const changes: FieldChanges = {};
  const errors: Record<string, string> = {};
  for (const { key, kind, label } of fields) {
    const parsed = parseBox(kind, values[key] ?? (kind === 'bool' ? false : ''));
    if ('error' in parsed) {
      errors[key] = parsed.error;
      continue;
    }
    const before = stored[key] ?? null;
    // A box left unticked on a value never set is no change; unticking a set value deletes it.
    const after = kind === 'bool' && parsed.value === null && before === false ? false : parsed.value;
    if (after === before) continue;
    if (after !== null) {
      const rule = schema.shape[key];
      if (!rule || !rule.safeParse(after).success) {
        errors[key] = `${label} is out of range.`;
        continue;
      }
    }
    changes[key] = after;
  }
  return { changes, errors };
}

export function factChanges(values: FormValues, stored: DraftField): FormResult {
  return changesOf(FACT_FIELDS, draftFieldSchema, values, stored);
}

export function roomChanges(values: FormValues, stored: RoomField): FormResult {
  const result = changesOf(ROOM_FIELDS, roomFieldSchema, values, stored);
  if (result.changes.name === null) {
    delete result.changes.name;
    result.errors.name = 'A room needs a name.';
  }
  return result;
}

// A new room's name, or null when it is not one the field map accepts.
export function roomName(raw: string): string | null {
  const name = raw.trim();
  return roomFieldSchema.shape.name.safeParse(name).success && name.length > 0 ? name : null;
}
