'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readScopeLists, type ScopeLists } from '@/lib/field/api';
import { roomName } from '@/lib/field/forms';
import { NO_TYPED, pending, typedBefore, usePending } from '@/lib/field/pending';
import { addRoom, removeRoom } from '@/lib/field/room-actions';
import { MAX_ROOMS, type RoomField } from '@/lib/field/schema';
import type { FieldDraft } from '@/lib/field/store';
import type { JobContext } from './job-screens';
import { RoomCard } from './room-card';
import { Box, Outcome, Section } from './ui';
import { useFieldEdit } from './use-field-edit';

// The rooms of Check Scope (S5a-6): each room is its own document in the field draft, listed in
// the draft's room order. Adding or removing a room changes both in one batch (src/lib/field/store.ts).
// The room types, items and prep-task templates the rooms pick from are read once (S5a-10).
export function RoomsSection({ job, draft }: { job: JobContext; draft: FieldDraft }) {
  const [lists, setLists] = useState<ScopeLists | null>(null);
  const [listsError, setListsError] = useState<string | null>(null);
  // A name typed and not added, kept on the page (src/lib/field/pending.ts).
  const jobId = job.jobId;
  const draftId = job.draftRef.draftId;
  const drafts = usePending(() => pending.typed(jobId));
  const typed = drafts[draftId] ?? NO_TYPED;
  const earlier = typedBefore(drafts, draftId);
  const name = typed.roomName;
  const setName = (text: string) => pending.typeRoomName(jobId, draftId, text);
  // A name typed and not added counts as unsaved input once the job is archived.
  const { markUnsaved } = job;
  const nameTyped = name !== '';
  useEffect(() => {
    markUnsaved('new-room', nameTyped);
    return () => markUnsaved('new-room', false);
  }, [markUnsaved, nameTyped]);
  // Rooms with changes typed and not saved, and rooms the draft no longer lists that had some when
  // the field work moved to someone else: they stay on screen, read only, as last read (J5).
  const [dirty, setDirty] = useState<Record<string, true>>({});
  const [last, setLast] = useState(draft.rooms);
  const [kept, setKept] = useState<{ id: string; field: RoomField; number: number }[]>([]);
  const onDirty = useCallback((roomId: string, isDirty: boolean) => {
    setDirty((current) => {
      if (Boolean(current[roomId]) === isDirty) return current;
      const next = { ...current };
      if (isDirty) next[roomId] = true;
      else delete next[roomId];
      return next;
    });
  }, []);
  if (last !== draft.rooms) {
    setLast(draft.rooms);
    const listed = new Set(draft.rooms.map((room) => room.id));
    const still = kept.filter((room) => !listed.has(room.id));
    const gone = job.editable
      ? []
      : last
          .map((room, index) => ({ id: room.id, field: room.field, number: index + 1 }))
          .filter((room) => !listed.has(room.id) && dirty[room.id] && !still.some((one) => one.id === room.id));
    setKept([...still, ...gone]);
  }
  const { busy, error, notice, setError, save: saveEdit } = useFieldEdit(job);
  const writing = usePending(() => pending.roomWriting(jobId, draftId));
  const readOnly = !job.editable;
  const full = draft.rooms.length >= MAX_ROOMS;
  const { user } = job.session;
  const { checkAccess } = job;

  function loadLists() {
    if (!job.session.online) return;
    void readScopeLists(user, jobId).then((answer) => {
      setLists(answer.ok ? answer.value : null);
      setListsError(answer.ok ? null : 'The room types, items and prep tasks could not be read. ' + answer.message);
      if (!answer.ok && answer.status === 410) checkAccess(answer);
    });
  }
  useEffect(loadLists, [user, jobId, job.session.online, checkAccess]);

  // Adding and removing rooms are built from the phone's cache under a guard (src/lib/field/room-actions.ts).
  const actions = { db: job.session.db, ref: job.draftRef, jobId, save: saveEdit, setError };
  async function remove(roomId: string, label: string) {
    if (writing || !window.confirm(`Remove ${label} from this job?`)) return;
    await removeRoom(actions, roomId, label, typed.rooms[roomId]?.at ?? 0);
  }

  async function add() {
    if (writing) return;
    const checked = roomName(name);
    if (!checked) return setError('Give the room a name.');
    await addRoom(actions, crypto.randomUUID(), checked, typed.nameAt);
  }

  // Rooms the draft does not list that still hold text typed and not added (on this draft or an
  // earlier one), apart from the ones kept above.
  const unlisted = [
    ...kept,
    ...Object.entries(typed.rooms).map(([id, room]) => ({ id, field: room.field, number: room.number })),
    ...Object.entries(earlier.rooms).map(([id, room]) => ({ id, field: room.field, number: room.number })),
  ].filter((room, at, all) => !draft.rooms.some((listed) => listed.id === room.id) && all.findIndex((one) => one.id === room.id) === at);

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
        {/* One list, so a room that leaves the draft keeps its card, and what was typed in it. */}
        {[
          ...draft.rooms.map((room, index) => ({ id: room.id, field: room.field, number: index + 1, listed: true })),
          ...unlisted.map((room) => ({ ...room, listed: false })),
        ].map((room) => (
          <li key={room.id}>
            <RoomCard
              job={job}
              roomId={room.id}
              stored={room.field}
              number={room.number}
              lists={lists}
              listed={room.listed}
              removing={busy || writing}
              onRemove={room.listed ? () => remove(room.id, room.field.name ?? `Room ${room.number}`) : undefined}
              onDirty={onDirty}
            />
          </li>
        ))}
      </ul>
      {/* A name typed and not added when the field work moved away: shown, read only (owner decision J5). */}
      {readOnly && name ? <Box id="new-room-name" label="New room name" value={name} onChange={() => undefined} readOnly /> : null}
      {/* Names typed and not added on an earlier draft of the job: read only, never added to this one. */}
      {earlier.roomNames.map((text, at) => (
        <Box key={at} id={`new-room-name-earlier-${at}`} label="Your earlier room name" value={text} onChange={() => undefined} readOnly />
      ))}
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
          <Button type="submit" variant="outline" disabled={busy || writing || full || job.stale}>
            {busy ? 'Adding…' : 'Add room'}
          </Button>
          {full ? <p className="text-sm">A job holds at most {MAX_ROOMS} rooms.</p> : null}
          <Outcome error={error} notice={notice} />
        </form>
      )}
    </Section>
  );
}
