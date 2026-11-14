// The Check Scope forms (S5a-6, room inputs S5a-10) on the field map (./schema.ts). A form holds what the technician
// typed, as text; these turn it into the keys to write, checked by the same Zod schema the server
// and the rules follow, so the phone never sends a value the rules would refuse. An empty box
// clears its value: the key is deleted, never written as null or zero.
import type { z } from 'zod';
import { draftFieldSchema, MAX_PREP_TASK, roomFieldSchema, type DraftField, type RoomField } from './schema';

// `choice` is a picked value: a number when it is digits, else the text itself ('' clears it).
// `list` is a room's items or prep tasks, edited as a whole (roomChanges below), never as a box.
type Kind = 'int' | 'decimal' | 'text' | 'bool' | 'choice' | 'list';
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
  { key: 'roomTypeId', label: 'Room type', kind: 'choice' },
  { key: 'category', label: 'Water category or mold', kind: 'choice' },
  { key: 'waterClass', label: 'Water class', kind: 'choice' },
  { key: 'ceilingHeightFt', label: 'Ceiling height (ft)', kind: 'decimal' },
  { key: 'moldCondition', label: 'Mold condition', kind: 'choice' },
  { key: 'affectedSf', label: 'Affected area (sq ft)', kind: 'decimal' },
  { key: 'floorSf', label: 'Floor area (sq ft)', kind: 'decimal' },
  { key: 'wetFloorSf', label: 'Wet floor area (sq ft)', kind: 'decimal' },
  { key: 'finishedSf', label: 'Finished wall area (sq ft)', kind: 'decimal' },
  { key: 'unfinishedSf', label: 'Unfinished wall area (sq ft)', kind: 'decimal' },
  { key: 'wastePercent', label: 'Waste (%)', kind: 'decimal' },
  { key: 'findings', label: 'Findings in this room', kind: 'text' },
  { key: 'items', label: 'Items in this room', kind: 'list' },
  { key: 'prepTasks', label: 'Prep tasks', kind: 'list' },
];

export type FormValues = Record<string, string | boolean>;
// The keys to write: a value to set, or null to delete the key.
export type FieldChanges = Record<string, string | number | boolean | string[] | Record<string, string> | null>;
export type FormResult = { changes: FieldChanges; errors: Record<string, string> };

const NUMBER = /^\d+(\.\d+)?$/;

// What a box shows for a stored value.
export function formOf<K extends string>(fields: FormField<K>[], stored: Partial<Record<K, unknown>>): FormValues {
  const values: FormValues = {};
  for (const { key, kind } of fields) {
    if (kind === 'list') continue;
    const value = stored[key];
    values[key] = kind === 'bool' ? value === true : value === undefined || value === null ? '' : String(value);
  }
  return values;
}

// What the boxes show: the stored values, with the person's own edits on top. Only edited boxes are
// held as edits, so a box the person never touched always shows (and saves) what is stored now,
// even after the draft was read again with someone else's change in it.
export function withEdits<K extends string>(fields: FormField<K>[], stored: Partial<Record<K, unknown>>, edits: FormValues): FormValues {
  return { ...formOf(fields, stored), ...edits };
}

// The edits still waiting after a save of `sent`: those changed again since it was sent.
export function editsAfterSave(edits: FormValues, sent: FormValues): FormValues {
  return Object.fromEntries(Object.entries(edits).filter(([key, value]) => sent[key] !== value));
}

function parseBox(kind: Kind, raw: string | boolean): { value: string | number | boolean | null } | { error: string } {
  if (kind === 'bool') return { value: raw === true ? true : null };
  const text = String(raw).trim();
  if (text === '') return { value: null };
  if (kind === 'text') return { value: text };
  if (kind === 'choice') return { value: /^\d+$/.test(text) ? Number(text) : text };
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
    if (kind === 'list') continue;
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

// A room's lists as edited on screen: each item's quantity as typed, and the prep tasks in order.
// Absent means untouched: the stored list stands.
export type RoomLists = { items?: Record<string, string>; prepTasks?: string[] };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function itemsChange(edited: Record<string, string>, stored: RoomField, result: FormResult): void {
  const items: Record<string, string> = {};
  for (const [itemId, raw] of Object.entries(edited)) {
    const text = raw.trim();
    if (!NUMBER.test(text)) {
      result.errors[`items.${itemId}`] = text === '' ? 'Enter a quantity, or remove the item.' : 'Enter a number.';
      continue;
    }
    // Stored as plain decimal text ("12.5", not "012.50"), so the same quantity is the same text.
    const value = Number(text);
    items[itemId] = Number.isFinite(value) && value <= 1e6 ? String(value) : text;
  }
  if (Object.keys(result.errors).some((key) => key.startsWith('items.'))) return;
  const sorted = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (sameJson(sorted(items), sorted(stored.items ?? {}))) return;
  if (Object.keys(items).length === 0) {
    result.changes.items = null;
    return;
  }
  const checked = roomFieldSchema.shape.items.safeParse(items);
  if (!checked.success) {
    // Each quantity on its own: 0 to 100,000 with at most two decimal places.
    for (const [itemId, quantity] of Object.entries(items)) {
      if (!roomFieldSchema.shape.items.safeParse({ [itemId]: quantity }).success) {
        result.errors[`items.${itemId}`] = 'Enter 0 to 100,000, with at most two decimal places.';
      }
    }
    result.errors.items ??= 'Check the items marked above.';
    return;
  }
  result.changes.items = items;
}

function prepTasksChange(edited: string[], stored: RoomField, result: FormResult): void {
  const tasks = edited.map((task) => task.trim()).filter((task) => task !== '');
  if (sameJson(tasks, stored.prepTasks ?? [])) return;
  if (tasks.length === 0) {
    result.changes.prepTasks = null;
    return;
  }
  if (!roomFieldSchema.shape.prepTasks.safeParse(tasks).success) {
    result.errors.prepTasks = `At most 10 prep tasks, each up to ${MAX_PREP_TASK} characters.`;
    return;
  }
  result.changes.prepTasks = tasks;
}

const HIDDEN_FOR_MOLD = ['waterClass', 'ceilingHeightFt'];
const HIDDEN_FOR_WATER = ['moldCondition', 'affectedSf'];

export function roomChanges(values: FormValues, stored: RoomField, lists: RoomLists = {}): FormResult {
  const shown = formOf(ROOM_FIELDS, stored);
  const hidden = values.category === 'mold' ? HIDDEN_FOR_MOLD : HIDDEN_FOR_WATER;
  const visible = { ...values, ...Object.fromEntries(hidden.map((key) => [key, shown[key]!])) };
  const result = changesOf(ROOM_FIELDS, roomFieldSchema, visible, stored);
  if (result.changes.name === null) {
    delete result.changes.name;
    result.errors.name = 'A room needs a name.';
  }
  if (lists.items) itemsChange(lists.items, stored, result);
  if (lists.prepTasks) prepTasksChange(lists.prepTasks, stored, result);
  return result;
}

// A new room's name, or null when it is not one the field map accepts.
export function roomName(raw: string): string | null {
  const name = raw.trim();
  return roomFieldSchema.shape.name.safeParse(name).success && name.length > 0 ? name : null;
}
