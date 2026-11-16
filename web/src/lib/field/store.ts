// The phone's reads and writes of one job's field draft in the field database (S5a-6), through the
// Firebase web SDK. Screens enqueue writes through fieldWrite on the shell's person client;
// local receipts and server acknowledgements are separate (./local-edit.ts). The rules (web/firestore.rules)
// let only the draft's field owner, while it is `editing`, change only the `field` maps; each write
// here changes nothing else, and its values come from ./forms.ts, checked by the same schema.
//
// Paths (docs/plans/S5.md, section 3): companies/{c}/drafts/{d} holds the job-level facts,
// drafts/{d}/rooms/{roomId} one room, drafts/{d}/photos/{photoId} one photo reference.
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  getDocFromCache,
  getDocsFromCache,
  setDoc,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { answerMessage, type Refusal } from './api';
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

// A stored map that does not follow the field map (./schema.ts). The draft is not shown at all
// rather than shown as empty or partial work.
export class InvalidFieldData extends Error {
  constructor() {
    super('stored field data does not match the field map');
    this.name = 'InvalidFieldData';
  }
}

// The room order lists a room whose document this read did not get (a cache that holds only part of
// the draft). The draft is not shown as if those rooms were never added.
export class IncompleteFieldData extends Error {
  constructor() {
    super('the room order lists rooms this read did not get');
    this.name = 'IncompleteFieldData';
  }
}

// The field database's rules refusing this person (or a sign-in it no longer takes), put as the
// jobs API would answer it; null for anything else (no signal, a timeout), which stays a failure to
// try again.
export function fieldRefusal(error: unknown): Refusal | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'permission-denied') return { status: 403, message: answerMessage(404, { error: 'not_found' }) };
  if (code === 'unauthenticated') return { status: 401, message: answerMessage(401, null) };
  return null;
}

function mapOf<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new InvalidFieldData();
  return parsed.data as T;
}

// The draft, rooms and photo references through the sync-gated client, or explicitly from the
// cache after a local edit. Returns null when there is no such draft. Throws InvalidFieldData when a stored map does not
// follow the field map, IncompleteFieldData when the room order lists a room the read did not get.
export async function loadDraft(db: Firestore, ref: DraftRef, source?: 'cache'): Promise<FieldDraft | null> {
  const path = draftPath(ref);
  const readDoc = source === 'cache' ? getDocFromCache : getDoc;
  const readDocs = source === 'cache' ? getDocsFromCache : getDocs;
  const [draft, rooms, photos] = await Promise.all([
    readDoc(doc(db, path)),
    readDocs(collection(db, path, 'rooms')),
    readDocs(collection(db, path, 'photos')),
  ]);
  if (!draft.exists()) return null;
  const data = draft.data();
  const field = mapOf<DraftField>(draftFieldSchema, data.field);
  const byId = new Map(rooms.docs.map((room) => [room.id, mapOf<RoomField>(roomFieldSchema, room.data().field)]));
  const order = field.roomOrder ?? [];
  if (order.some((id) => !byId.has(id))) throw new IncompleteFieldData();
  return {
    state: typeof data.state === 'string' ? data.state : 'unknown',
    fieldOwnerUid: typeof data.fieldOwnerUid === 'string' ? data.fieldOwnerUid : null,
    field,
    rooms: order.map((id) => ({ id, field: byId.get(id)! })),
    photos: photos.docs.map((photo) => ({ id: photo.id, field: mapOf<PhotoField>(photoFieldSchema, photo.data().field) })),
  };
}

export const SUPERSEDED = Symbol('superseded');

// One screen's reads of its draft: a read answers only while no newer read has started, so a slow
// read never replaces the draft a newer read (one after a local edit) put on screen.
// A superseded read answers only after the newest one has, so its caller never acts on the
// draft before the newer read is on screen.
export function draftReads() {
  let latest = 0;
  let newest: Promise<unknown> = Promise.resolve();
  async function read(db: Firestore, ref: DraftRef, source: 'cache' | undefined, mine: number): Promise<FieldDraft | null | typeof SUPERSEDED> {
    let outcome: { found: FieldDraft | null } | { error: unknown };
    try {
      outcome = { found: await loadDraft(db, ref, source) };
    } catch (error) {
      outcome = { error };
    }
    if (mine !== latest) {
      for (let waited: Promise<unknown> | null = null; waited !== newest; ) {
        waited = newest;
        await waited.catch(() => undefined);
      }
      return SUPERSEDED;
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.found;
  }
  return (db: Firestore, ref: DraftRef, source?: 'cache'): Promise<FieldDraft | null | typeof SUPERSEDED> => {
    const answer = read(db, ref, source, ++latest);
    newest = answer;
    return answer;
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
export async function addRoom(db: Firestore, ref: DraftRef, roomId: string, name: string, order: readonly string[]): Promise<void> {
  const path = draftPath(ref);
  const batch = writeBatch(db);
  batch.set(doc(db, path, 'rooms', roomId), { field: { name } });
  batch.update(doc(db, path), { 'field.roomOrder': [...order.filter((id) => id !== roomId), roomId] });
  await batch.commit();
}

// Removes a room: its document and its place in the room order, in one batch (the rules let only
// the field owner delete a room, while the draft is editing). A photo tagged to it shows untagged.
export async function removeRoom(db: Firestore, ref: DraftRef, roomId: string, order: readonly string[]): Promise<void> {
  const path = draftPath(ref);
  const batch = writeBatch(db);
  batch.delete(doc(db, path, 'rooms', roomId));
  batch.update(doc(db, path), { 'field.roomOrder': order.filter((id) => id !== roomId) });
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
