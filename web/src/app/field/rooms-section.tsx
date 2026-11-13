'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { editsAfterSave, ROOM_FIELDS, roomChanges, roomName, withEdits, type FormValues } from '@/lib/field/forms';
import { MAX_ROOMS, type RoomField } from '@/lib/field/schema';
import { addRoom, removeRoom, saveRoomField, type FieldDraft } from '@/lib/field/store';
import type { JobContext } from './job-screens';
import { Box, Choice, Outcome, Section } from './ui';

export const CATEGORY_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: '1', label: 'Category 1: clean water' },
  { value: '2', label: 'Category 2: gray water' },
  { value: '3', label: 'Category 3: black water' },
];

// The rooms of Check Scope (S5a-6): each room is its own document in the field draft, listed in
// the draft's room order. Adding or removing a room changes both in one batch (src/lib/field/store.ts).
export function RoomsSection({ job, draft }: { job: JobContext; draft: FieldDraft }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const readOnly = !job.editable;
  const full = draft.rooms.length >= MAX_ROOMS;

  async function remove(roomId: string, label: string) {
    const db = job.session.db;
    if (!db || !window.confirm(`Remove ${label} from this job?`)) return;
    setError(null);
    setNotice(null);
    try {
      await removeRoom(db, job.draftRef, roomId);
      await job.reloadDraft();
      setNotice(`${label} removed.`);
    } catch {
      setError('The room was not removed. Check the signal and try again.');
    }
  }

  async function add() {
    const db = job.session.db;
    const checked = roomName(name);
    if (!db) return;
    if (!checked) return setError('Give the room a name.');
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await addRoom(db, job.draftRef, crypto.randomUUID(), checked);
      await job.reloadDraft();
      setName('');
      setNotice(`${checked} added.`);
    } catch {
      setError('The room was not added. Check the signal and add it again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Rooms">
      {draft.rooms.length === 0 ? <p>No rooms yet.</p> : null}
      <ul className="flex flex-col gap-3" aria-label="Rooms">
        {draft.rooms.map((room, index) => (
          <li key={room.id}>
            <RoomCard
              job={job}
              roomId={room.id}
              stored={room.field}
              number={index + 1}
              onRemove={() => remove(room.id, room.field.name ?? `Room ${index + 1}`)}
            />
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <form
          className="flex flex-col gap-2"
          aria-label="Add a room"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Box id="new-room-name" label="New room name" value={name} onChange={setName} readOnly={full} />
          <Button type="submit" variant="outline" disabled={busy || full}>
            {busy ? 'Adding…' : 'Add room'}
          </Button>
          {full ? <p className="text-sm">A job holds at most {MAX_ROOMS} rooms.</p> : null}
          <Outcome error={error} notice={notice} />
        </form>
      )}
    </Section>
  );
}

// One room's name, category and areas, saved on their own; `onRemove` takes the room out of the job.
export function RoomCard({
  job,
  roomId,
  stored,
  number,
  onRemove,
}: {
  job: JobContext;
  roomId: string;
  stored: RoomField;
  number: number;
  onRemove?: () => Promise<void>;
}) {
  // Only the boxes the person changed; the rest always show the room as last read.
  const [edits, setEdits] = useState<FormValues>({});
  const values = withEdits(ROOM_FIELDS, stored, edits);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const readOnly = !job.editable;
  const set = (key: string) => (value: string) => {
    setEdits((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };
  const title = stored.name ?? `Room ${number}`;

  async function save() {
    const db = job.session.db;
    if (!db) return;
    const { changes, errors: found } = roomChanges(values, stored);
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) return setError('Check the boxes marked above.');
    setError(null);
    setBusy(true);
    const sent = edits;
    try {
      await saveRoomField(db, job.draftRef, roomId, changes);
      setEdits((current) => editsAfterSave(current, sent));
      await job.reloadDraft();
      setNotice(Object.keys(changes).length === 0 ? 'Nothing to save.' : 'Room saved.');
    } catch {
      setError('The room was not saved. Check the signal and save again.');
    } finally {
      setBusy(false);
    }
  }

  const id = (key: string) => `room-${roomId}-${key}`;
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
      <Choice id={id('category')} label="Water category" value={String(values.category)} options={CATEGORY_OPTIONS} onChange={set('category')} readOnly={readOnly} />
      <div className="grid grid-cols-2 gap-3">
        {ROOM_FIELDS.filter((field) => field.kind === 'decimal').map((field) => (
          <Box
            key={field.key}
            id={id(field.key)}
            label={field.label}
            value={String(values[field.key])}
            onChange={set(field.key)}
            readOnly={readOnly}
            error={errors[field.key]}
            inputMode="decimal"
          />
        ))}
      </div>
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={busy}>
            {busy ? 'Saving…' : 'Save room'}
          </Button>
          {onRemove ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void onRemove()}>
              Remove room
            </Button>
          ) : null}
        </div>
      )}
      <Outcome error={error} notice={notice} />
    </form>
  );
}
