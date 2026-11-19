import type { Firestore } from 'firebase/firestore';
import type { Docs, DocWrite } from './journal';
import { pending } from './pending';
import { MAX_ROOMS } from './schema';
import { addRoomEdit, removeRoomEdit, type DraftRef } from './store';

// The Add and Remove of the Rooms section of Check Scope. Both write the whole room order, so only
// one runs for a draft at a time (./pending.ts startRoomWrite), and each is built from the phone's
// cache read again under that guard (./store.ts addRoomEdit, removeRoomEdit), never from what a
// screen rendered. `save` is the screen's local save (app/field/use-field-edit.ts): it answers
// whether the change is on the phone.
export type RoomSave = (writes: DocWrite[], saved: string, locallySaved?: undefined, acknowledgedBy?: () => void, held?: Docs) => Promise<boolean>;
type RoomActions = { db: Firestore; ref: DraftRef; jobId: string; save: RoomSave; setError: (message: string) => void };

const UNREADABLE = "Can't save. The rooms saved on this phone could not be read. Open the job again.";

// `sent` is the time the room's typed task was typed (src/lib/field/pending.ts settleRoomRemoved).
export async function removeRoom({ db, ref, jobId, save, setError }: RoomActions, roomId: string, label: string, sent: number): Promise<void> {
  if (!pending.startRoomWrite(jobId, ref.draftId)) return;
  let onPhone = false;
  try {
    const edit = await removeRoomEdit(db, ref, roomId).catch(() => null);
    if (!edit) return setError(UNREADABLE);
    onPhone = await save(edit.writes, `${label} removed.`, undefined, () => pending.settleRoomRemoved(jobId, ref.draftId, roomId, sent), edit.held);
  } finally {
    pending.endRoomWrite(jobId, ref.draftId);
    if (onPhone) pending.draftChanged(jobId);
  }
}

// `sent` is the time the name was typed (settleRoomName).
export async function addRoom({ db, ref, jobId, save, setError }: RoomActions, roomId: string, name: string, sent: number): Promise<void> {
  if (!pending.startRoomWrite(jobId, ref.draftId)) return;
  let onPhone = false;
  try {
    const edit = await addRoomEdit(db, ref, roomId, name).catch(() => null);
    if (!edit) return setError(UNREADABLE);
    if (edit === 'full') return setError(`A job holds at most ${MAX_ROOMS} rooms.`);
    onPhone = await save(edit.writes, `${name} added.`, undefined, undefined, edit.held);
    if (onPhone) pending.settleRoomName(jobId, ref.draftId, sent);
  } finally {
    pending.endRoomWrite(jobId, ref.draftId);
    if (onPhone) pending.draftChanged(jobId);
  }
}
