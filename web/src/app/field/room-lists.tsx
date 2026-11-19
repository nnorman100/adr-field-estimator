'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ScopeLists } from '@/lib/field/api';
import { MAX_PREP_TASK, MAX_PREP_TASKS, MAX_ROOM_ITEMS } from '@/lib/field/schema';
import { Box, Choice } from './ui';

// A room's lists on Check Scope (S5a-10): the items typed for the room, each with the quantity the
// estimator types, and the room's prep tasks. Both are edited on screen and saved with the room
// (room-card.tsx); `edited` is undefined until the person changes the list. The room type's
// suggestions show beside them: one typed per room is added to the room's items; one priced from
// the room's measurements or the job's counts is only shown, for the technician to confirm.

const UNITS: Record<string, string> = {
  sf: 'sq ft',
  lf: 'linear ft',
  each: 'each',
  hour: 'hours',
  day: 'days',
  unit_day: 'unit days',
  load: 'loads',
  visit: 'visits',
  room: 'rooms',
};

export function RoomItems({
  id,
  stored,
  edited,
  onChange,
  lists,
  suggested,
  errors,
  readOnly,
}: {
  id: string;
  stored: Record<string, string>;
  edited: Record<string, string> | undefined;
  onChange: (items: Record<string, string>) => void;
  lists: ScopeLists | null;
  suggested: ScopeLists['roomTypes'][number]['suggestedItems'];
  errors: Record<string, string>;
  readOnly: boolean;
}) {
  const [pick, setPick] = useState('');
  const known = lists?.items ?? [];
  const byId = new Map(known.map((item) => [item.itemId, item]));
  const order = new Map(known.map((item, index) => [item.itemId, index]));
  const current = edited ?? stored;
  const ids = Object.keys(current).sort((a, b) => (order.get(a) ?? known.length) - (order.get(b) ?? known.length) || (a < b ? -1 : a > b ? 1 : 0));
  const full = ids.length >= MAX_ROOM_ITEMS;
  const nameOf = (itemId: string) => byId.get(itemId)?.name ?? `${itemId} (not in this job’s price list)`;
  const add = (itemId: string) => {
    if (!itemId || itemId in current || full) return;
    onChange({ ...current, [itemId]: '' });
  };
  const remove = (itemId: string) => {
    const next = { ...current };
    delete next[itemId];
    onChange(next);
  };
  const offered = suggested.filter((item) => item.typed && !(item.itemId in current));
  const measured = suggested.filter((item) => !item.typed);
  const others = known.filter((item) => !(item.itemId in current));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">Items in this room</legend>
      {ids.length === 0 ? <p className="text-sm">No items typed for this room.</p> : null}
      <ul className="flex flex-col gap-2" aria-label="Items in this room">
        {ids.map((itemId) => {
          const unit = byId.get(itemId)?.unit;
          return (
            <li key={itemId} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Box
                  id={`${id}-${itemId}`}
                  label={`${nameOf(itemId)}${unit ? ` (${UNITS[unit] ?? unit})` : ''}`}
                  value={current[itemId] ?? ''}
                  onChange={(value) => onChange({ ...current, [itemId]: value })}
                  readOnly={readOnly}
                  error={errors[`items.${itemId}`]}
                  inputMode="decimal"
                />
              </div>
              {readOnly ? null : (
                <Button type="button" variant="outline" aria-label={`Remove ${nameOf(itemId)}`} onClick={() => remove(itemId)}>
                  Remove
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {measured.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm">Also suggested for this room type, priced from this room’s measurements or the job’s counts. Confirm them by entering the areas and counts.</p>
          <ul className="list-disc pl-5 text-sm" aria-label="Priced from this room’s measurements">
            {measured.map((item) => (
              <li key={item.itemId}>{item.name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {readOnly ? null : (
        <>
          {offered.length > 0 && !full ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">Suggested for this room type. Add the ones this room needs, then type each quantity.</p>
              <div className="flex flex-wrap gap-2">
                {offered.map((item) => (
                  <Button key={item.itemId} type="button" variant="outline" onClick={() => add(item.itemId)}>
                    Add {nameOf(item.itemId)}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          {others.length > 0 && !full ? (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Choice
                  id={`${id}-pick`}
                  label="Another item"
                  value={pick}
                  options={[{ value: '', label: 'Choose an item' }, ...others.map((item) => ({ value: item.itemId, label: item.name }))]}
                  onChange={setPick}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!pick}
                onClick={() => {
                  add(pick);
                  setPick('');
                }}
              >
                Add item
              </Button>
            </div>
          ) : null}
          {lists && known.length === 0 ? <p className="text-sm">This job’s price list has no items typed per room.</p> : null}
          {full ? <p className="text-sm">A room lists at most {MAX_ROOM_ITEMS} items.</p> : null}
        </>
      )}
      {errors.items ? <p className="text-sm font-medium text-red-800">{errors.items}</p> : null}
    </fieldset>
  );
}

export function RoomPrepTasks({
  id,
  stored,
  edited,
  onChange,
  templates,
  error,
  readOnly,
  own,
  setOwn,
  earlier,
}: {
  id: string;
  stored: string[];
  edited: string[] | undefined;
  onChange: (tasks: string[]) => void;
  templates: string[];
  error: string | undefined;
  readOnly: boolean;
  // The prep task typed and not added yet, held on the page (src/lib/field/pending.ts) so the room's
  // card stays on screen with it after a move (owner decision J5).
  own: string;
  setOwn: (text: string) => void;
  // Prep tasks typed and not added on an earlier draft of the job: shown read only, never added here.
  earlier: string[];
}) {
  const [pick, setPick] = useState('');
  const tasks = edited ?? stored;
  const full = tasks.length >= MAX_PREP_TASKS;
  // A template's words are copied into the room when picked, so the record keeps them as they were.
  const offered = templates.map((text) => text.trim()).filter((text) => text !== '' && !tasks.includes(text));
  const add = (text: string) => {
    const task = text.trim();
    if (!task || full || tasks.includes(task)) return;
    onChange([...tasks, task]);
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">Prep tasks</legend>
      {tasks.length === 0 ? <p className="text-sm">No prep tasks for this room.</p> : null}
      <ol className="flex list-decimal flex-col gap-2 pl-5" aria-label="Prep tasks">
        {tasks.map((task, index) => (
          <li key={`${index}-${task}`}>
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 py-2 break-words">{task}</p>
              {readOnly ? null : (
                <Button type="button" variant="outline" aria-label={`Remove prep task ${index + 1}`} onClick={() => onChange(tasks.filter((_, at) => at !== index))}>
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {earlier.map((text, at) => (
        <Box key={at} id={`${id}-earlier-${at}`} label="Your earlier prep task" value={text} onChange={() => undefined} readOnly />
      ))}
      {/* Typed and not added when the field work moved away: shown, read only (owner decision J5). */}
      {readOnly && own ? <Box id={`${id}-own`} label="Your own prep task" value={own} onChange={() => undefined} readOnly /> : null}
      {readOnly || full ? null : (
        <>
          {offered.length > 0 ? (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Choice
                  id={`${id}-template`}
                  label="From the company list"
                  value={offered.includes(pick) ? pick : ''}
                  options={[{ value: '', label: 'Choose a prep task' }, ...offered.map((text) => ({ value: text, label: text }))]}
                  onChange={setPick}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!offered.includes(pick)}
                onClick={() => {
                  add(pick);
                  setPick('');
                }}
              >
                Add task
              </Button>
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Box id={`${id}-own`} label="Your own prep task" value={own} onChange={(value) => setOwn(value.slice(0, MAX_PREP_TASK))} />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!own.trim()}
              onClick={() => {
                add(own);
                setOwn('');
              }}
            >
              Add own task
            </Button>
          </div>
        </>
      )}
      {full && !readOnly ? <p className="text-sm">A room lists at most {MAX_PREP_TASKS} prep tasks.</p> : null}
      {error ? <p className="text-sm font-medium text-red-800">{error}</p> : null}
    </fieldset>
  );
}
