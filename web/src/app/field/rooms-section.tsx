'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readScopeLists, type ScopeLists } from '@/lib/field/api';
import { roomName } from '@/lib/field/forms';
import { MAX_ROOMS } from '@/lib/field/schema';
import { addRoom, fieldRefusal, removeRoom, type FieldDraft } from '@/lib/field/store';
import type { JobContext } from './job-screens';
import { RoomCard } from './room-card';
import { Box, Outcome, Section } from './ui';

// The rooms of Check Scope (S5a-6): each room is its own document in the field draft, listed in
// the draft's room order. Adding or removing a room changes both in one batch (src/lib/field/store.ts).
// The room types, items and prep-task templates the rooms pick from are read once (S5a-10).
export function RoomsSection({ job, draft }: { job: JobContext; draft: FieldDraft }) {
  const [lists, setLists] = useState<ScopeLists | null>(null);
  const [listsError, setListsError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const readOnly = !job.editable;
  const full = draft.rooms.length >= MAX_ROOMS;
  const { user } = job.session;
  const jobId = job.detail.job.id;

  function loadLists() {
    void readScopeLists(user, jobId).then((answer) => {
      setLists(answer.ok ? answer.value : null);
      setListsError(answer.ok ? null : 'The room types, items and prep tasks could not be read. ' + answer.message);
    });
  }
  useEffect(loadLists, [user, jobId]);

  async function remove(roomId: string, label: string) {
    const db = job.session.db;
    if (!db || !window.confirm(`Remove ${label} from this job?`)) return;
    setError(null);
    setNotice(null);
    try {
      await removeRoom(db, job.draftRef, roomId);
      await job.reloadDraft();
      setNotice(`${label} removed.`);
    } catch (error) {
      setError('The room was not removed. Check the signal and try again.');
      job.checkAccess(fieldRefusal(error));
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
      setName((current) => (current === name ? '' : current));
      setNotice(`${checked} added.`);
    } catch (error) {
      setError('The room was not added. Check the signal and add it again.');
      job.checkAccess(fieldRefusal(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Rooms">
      {listsError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{listsError}</p>
          <Button type="button" variant="outline" onClick={loadLists}>
            Read the lists again
          </Button>
        </div>
      ) : null}
      {draft.rooms.length === 0 ? <p>No rooms yet.</p> : null}
      <ul className="flex flex-col gap-3" aria-label="Rooms">
        {draft.rooms.map((room, index) => (
          <li key={room.id}>
            <RoomCard
              job={job}
              roomId={room.id}
              stored={room.field}
              number={index + 1}
              lists={lists}
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
