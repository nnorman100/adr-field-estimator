import type { FirebaseApp } from 'firebase/app';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  getDocsFromServer,
  getFirestore,
  waitForPendingWrites,
  type Firestore,
} from 'firebase/firestore';
import type { BrowserSignInConfig } from '@/lib/config';
import type { FieldManifest } from '@/lib/field/canonical';

// The browser's read of a field draft for Finish and review (docs/plans/S5.md, section 4, step 1):
// this phone's own writes first reach the field database, then the draft, its rooms and its photo
// references are read from the server (never from a cache), so what the screen shows and hashes is
// what Submit will read after the fence. The field rules let the owner, office and the draft's field
// owner read it; the signed-in user of the company's own Firebase app reads it.

const connected = new WeakSet<Firestore>();

export function fieldDatabase(app: FirebaseApp, config: BrowserSignInConfig): Firestore | null {
  if (!config.firestoreDatabaseId) return null;
  const db = getFirestore(app, config.firestoreDatabaseId);
  if (config.firestoreEmulatorUrl && !connected.has(db)) {
    const url = new URL(config.firestoreEmulatorUrl);
    connectFirestoreEmulator(db, url.hostname, Number(url.port));
    connected.add(db);
  }
  return db;
}

export type ShownDraft = { state: string; manifest: FieldManifest };

// The draft as the field database holds it now, or null when there is no such draft.
export async function readShownDraft(db: Firestore, companyId: string, draftId: string): Promise<ShownDraft | null> {
  await waitForPendingWrites(db);
  const ref = doc(db, 'companies', companyId, 'drafts', draftId);
  const draft = await getDocFromServer(ref);
  if (!draft.exists()) return null;
  const [rooms, photos] = await Promise.all([getDocsFromServer(collection(ref, 'rooms')), getDocsFromServer(collection(ref, 'photos'))]);
  const state = draft.get('state');
  return {
    state: typeof state === 'string' ? state : '',
    manifest: {
      draft: draft.get('field') ?? {},
      rooms: rooms.docs.map((room) => ({ id: room.id, field: room.get('field') ?? {} })),
      photos: photos.docs.map((photo) => ({ id: photo.id, field: photo.get('field') ?? {} })),
    },
  };
}
