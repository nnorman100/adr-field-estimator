'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ScopeLists } from '@/lib/field/api';
import { editsAfterSave, roomChanges, roomTypeChoice, ROOM_FIELDS, withEdits, type FormValues, type RoomLists } from '@/lib/field/forms';
import { MAX_FINDINGS, type RoomField } from '@/lib/field/schema';
import { saveRoomField } from '@/lib/field/store';
import type { JobContext } from './job-screens';
import { RoomItems, RoomPrepTasks } from './room-lists';
import { Box, Choice, Outcome, READ_AGAIN } from './ui';
import { useFieldEdit } from './use-field-edit';

export const CATEGORY_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: '1', label: 'Category 1: clean water' },
  { value: '2', label: 'Category 2: gray water' },
  { value: '3', label: 'Category 3: black water' },
  { value: 'mold', label: 'Mold' },
];

const WATER_CLASSES = [
  { value: '1', label: 'Class 1: least water, little absorbed' },
  { value: '2', label: 'Class 2: carpet and cushion wet, walls wet under 24 in' },
  { value: '3', label: 'Class 3: walls wet above 24 in, ceiling or insulation wet' },
  { value: '4', label: 'Class 4: deep saturation (wood, plaster, concrete)' },
];

const MOLD_CONDITIONS = [
  { value: '1', label: 'Condition 1: normal fungal ecology' },
  { value: '2', label: 'Condition 2: settled spores, no visible growth' },
  { value: '3', label: 'Condition 3: actual growth' },
];

// A group of mutually exclusive options as radio buttons (four or fewer options), plus "Not set".
function Radios({
  id,
  legend,
  value,
  options,
  onChange,
  readOnly,
}: {
  id: string;
  legend: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  readOnly: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{legend}</legend>
      {[{ value: '', label: 'Not set' }, ...options].map((option) => (
        <div key={option.value} className="flex min-h-11 items-center gap-3">
          <input
            id={`${id}-${option.value || 'none'}`}
            type="radio"
            name={id}
            value={option.value}
            className="size-5 shrink-0"
            checked={value === option.value}
            disabled={readOnly}
            onChange={() => onChange(option.value)}
          />
          <label htmlFor={`${id}-${option.value || 'none'}`} className="text-base">
            {option.label}
          </label>
        </div>
      ))}
    </fieldset>
  );
}

// One room on Check Scope (S5a-6, room inputs S5a-10): its name, room type, category, water class
// or mold condition and affected area, areas, the items typed for it, its prep tasks and its
// findings, saved together; `onRemove` takes the room out of the job. The room types, items and
// prep-task templates come from the job's price version and Company settings (`lists`); none of it
// carries a price.
export function RoomCard({
  job,
  roomId,
  stored,
  number,
  lists,
  onRemove,
}: {
  job: JobContext;
  roomId: string;
  stored: RoomField;
  number: number;
  lists: ScopeLists | null;
  onRemove?: () => Promise<void>;
}) {
  // Only the boxes the person changed; the rest always show the room as last read.
  const [edits, setEdits] = useState<FormValues>({});
  const [listEdits, setListEdits] = useState<RoomLists>({});
  const values = withEdits(ROOM_FIELDS, stored, edits);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, notice, setError, setNotice, save: saveEdit } = useFieldEdit(job);
  const readOnly = !job.editable;
  const set = (key: string) => (value: string) => {
    setEdits((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };
  const setList = (next: RoomLists) => {
    setListEdits((current) => ({ ...current, ...next }));
    setNotice(null);
  };
  const title = stored.name ?? `Room ${number}`;
  const mold = values.category === 'mold';

  async function save() {
    if (job.stale) return;
    const { changes, errors: found } = roomChanges(values, stored, listEdits);
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) return setError('Check the boxes marked in this room.');
    setError(null);
    const sent = edits;
    const sentLists = listEdits;
    if (Object.keys(changes).length === 0) return setNotice('Nothing to save.');
    await saveEdit((db) => saveRoomField(db, job.draftRef, roomId, changes), 'Room saved.', () => {
      setEdits((current) => editsAfterSave(current, sent));
      // A list changed again while saving stays as edited; one saved as sent shows the stored list.
      setListEdits((current) => ({
        ...(current.items !== sentLists.items ? { items: current.items } : {}),
        ...(current.prepTasks !== sentLists.prepTasks ? { prepTasks: current.prepTasks } : {}),
      }));
    });
  }

  const id = (key: string) => `room-${roomId}-${key}`;
  const area = (key: string) => {
    const field = ROOM_FIELDS.find((candidate) => candidate.key === key)!;
    return (
      <Box
        key={key}
        id={id(key)}
        label={field.label}
        value={String(values[key])}
        onChange={set(key)}
        readOnly={readOnly}
        error={errors[key]}
        inputMode="decimal"
      />
    );
  };
  const roomType = roomTypeChoice(lists?.roomTypes ?? [], String(values.roomTypeId), String(values.category));

  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-foreground/20 p-3"
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h4 className="text-base font-semibold">{title}</h4>
      <Box id={id('name')} label="Room name" value={String(values.name)} onChange={set('name')} readOnly={readOnly} error={errors.name} />
      <Choice id={id('roomTypeId')} label="Room type" value={roomType.value} options={roomType.options} onChange={set('roomTypeId')} readOnly={readOnly} />
      <Choice
        id={id('category')}
        label="Water category or mold"
        value={String(values.category)}
        options={CATEGORY_OPTIONS}
        onChange={set('category')}
        readOnly={readOnly}
      />
      {mold ? (
        <>
          <Radios id={id('moldCondition')} legend="Mold condition" value={String(values.moldCondition)} options={MOLD_CONDITIONS} onChange={set('moldCondition')} readOnly={readOnly} />
          {area('affectedSf')}
        </>
      ) : (
        <>
          <Radios id={id('waterClass')} legend="Water class" value={String(values.waterClass)} options={WATER_CLASSES} onChange={set('waterClass')} readOnly={readOnly} />
          {area('ceilingHeightFt')}
        </>
      )}
      <div className="grid grid-cols-2 gap-3">{['floorSf', 'wetFloorSf', 'finishedSf', 'unfinishedSf', 'wastePercent'].map(area)}</div>
      <RoomItems
        id={id('items')}
        stored={stored.items ?? {}}
        edited={listEdits.items}
        onChange={(items) => setList({ items })}
        lists={lists}
        suggested={roomType.suggested}
        errors={errors}
        readOnly={readOnly}
      />
      <RoomPrepTasks
        id={id('prep')}
        stored={stored.prepTasks ?? []}
        edited={listEdits.prepTasks}
        onChange={(prepTasks) => setList({ prepTasks })}
        templates={lists?.prepTasks ?? []}
        error={errors.prepTasks}
        readOnly={readOnly}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={id('findings')} className="text-sm font-medium">
          Findings in this room
        </label>
        <textarea
          id={id('findings')}
          rows={3}
          maxLength={MAX_FINDINGS}
          readOnly={readOnly}
          value={String(values.findings)}
          onChange={(event) => set('findings')(event.target.value)}
          className="w-full rounded-md border border-foreground/40 bg-background p-3 text-base read-only:bg-foreground/5"
        />
      </div>
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={busy || job.stale}>
            {busy ? 'Saving…' : 'Save room'}
          </Button>
          {onRemove ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void onRemove()}>
              Remove room
            </Button>
          ) : null}
        </div>
      )}
      {!readOnly && job.stale ? <p className="text-sm">{READ_AGAIN}</p> : null}
      <Outcome error={error} notice={notice} />
    </form>
  );
}
