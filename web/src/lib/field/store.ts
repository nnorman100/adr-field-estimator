// The phone's reads and writes of one job's field draft in the field database (S5a-6), through the
// Firebase web SDK. Online only for now (S6 adds the phone's own store): every write waits for the
// field database to accept it, so "Saved" on screen means saved. The rules (web/firestore.rules)
// let only the draft's field owner, while it is `editing`, change only the `field` maps; each write
// here changes nothing else, and its values come from ./forms.ts, checked by the same schema.
//
// Paths (docs/plans/S5.md, section 3): companies/{c}/drafts/{d} holds the job-level facts,
// drafts/{d}/rooms/{roomId} one room, drafts/{d}/photos/{photoId} one photo reference.
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteField,
  doc,
  getDocFromServer,
  getDocsFromServer,
  setDoc,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { FieldChanges } from './forms';
import { draftFieldSchema, photoFieldSchema, roomFieldSchema, type DraftField, type PhotoField, type RoomField } from './schema';

export type DraftRef = { companyId: string; draftId: string };

export type FieldDraft = {
  state: string;
  fieldOwnerUid: string | null;
  field: DraftField;
  // In the draft's room order; a room document the order does not list is not shown.
  rooms: { id: string; field: RoomField }[];
  photos: { id: string; field: PhotoField }[];
};

export const draftPath = ({ companyId, draftId }: DraftRef) => `companies/${companyId}/drafts/${draftId}`;

// A stored map that does not follow field map v1 (./schema.ts). The draft is not shown at all
// rather than shown as empty or partial work.
export class InvalidFieldData extends Error {
  constructor() {
    super('stored field data does not match the field map');
    this.name = 'InvalidFieldData';
  }
}

function mapOf<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new InvalidFieldData();
  return parsed.data as T;
}

// The draft, its rooms and its photo references, read from the field database itself (never a
// cache), or null when there is no such draft. Throws InvalidFieldData when a stored map does not
// follow the field map.
export async function loadDraft(db: Firestore, ref: DraftRef): Promise<FieldDraft | null> {
  const path = draftPath(ref);
  const [draft, rooms, photos] = await Promise.all([
    getDocFromServer(doc(db, path)),
    getDocsFromServer(collection(db, path, 'rooms')),
    getDocsFromServer(collection(db, path, 'photos')),
  ]);
  if (!draft.exists()) return null;
  const data = draft.data();
  const field = mapOf<DraftField>(draftFieldSchema, data.field);
  const byId = new Map(rooms.docs.map((room) => [room.id, mapOf<RoomField>(roomFieldSchema, room.data().field)]));
  return {
    state: typeof data.state === 'string' ? data.state : 'unknown',
    fieldOwnerUid: typeof data.fieldOwnerUid === 'string' ? data.fieldOwnerUid : null,
    field,
    rooms: (field.roomOrder ?? []).filter((id) => byId.has(id)).map((id) => ({ id, field: byId.get(id)! })),
    photos: photos.docs.map((photo) => ({ id: photo.id, field: mapOf<PhotoField>(photoFieldSchema, photo.data().field) })),
  };
}

// The changed keys of one `field` map, by dotted path, so a save never overwrites a key it did not
// change; a null deletes the key.
function dotted(changes: FieldChanges): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(changes).map(([key, value]) => [`field.${key}`, value === null ? deleteField() : value]),
  );
}

export async function saveDraftField(db: Firestore, ref: DraftRef, changes: FieldChanges): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  await updateDoc(doc(db, draftPath(ref)), dotted(changes));
}

// A new room: its document and its place at the end of the room order, in one batch, so a room is
// never listed without its document or the other way round.
export async function addRoom(db: Firestore, ref: DraftRef, roomId: string, name: string): Promise<void> {
  const path = draftPath(ref);
  const batch = writeBatch(db);
  batch.set(doc(db, path, 'rooms', roomId), { field: { name } });
  batch.update(doc(db, path), { 'field.roomOrder': arrayUnion(roomId) });
  await batch.commit();
}

// Removes a room: its document and its place in the room order, in one batch (the rules let only
// the field owner delete a room, while the draft is editing). A photo tagged to it shows untagged.
export async function removeRoom(db: Firestore, ref: DraftRef, roomId: string): Promise<void> {
  const path = draftPath(ref);
  const batch = writeBatch(db);
  batch.delete(doc(db, path, 'rooms', roomId));
  batch.update(doc(db, path), { 'field.roomOrder': arrayRemove(roomId) });
  await batch.commit();
}

export async function saveRoomField(db: Firestore, ref: DraftRef, roomId: string, changes: FieldChanges): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  await updateDoc(doc(db, draftPath(ref), 'rooms', roomId), dotted(changes));
}

// A photo's reference, written once its bytes have a receipt (S5a-5), and again when its room or
// shot tag changes. The whole map is written: it has two keys, both chosen on screen.
export async function savePhotoRef(db: Firestore, ref: DraftRef, photoId: string, field: PhotoField): Promise<void> {
  await setDoc(doc(db, draftPath(ref), 'photos', photoId), { field });
}

// Whether this person may change the draft's field work now: the rules' own test (canEdit).
export function canEditDraft(draft: Pick<FieldDraft, 'state' | 'fieldOwnerUid'>, uid: string, capabilities: readonly string[]): boolean {
  return capabilities.includes('scope') && draft.fieldOwnerUid === uid && draft.state === 'editing';
}
