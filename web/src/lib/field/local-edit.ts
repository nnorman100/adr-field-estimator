import { doc, getDocFromCache, type Firestore } from 'firebase/firestore';
import { fieldWrite, type FieldClient } from '@/lib/field-db';
import { draftPath, type DraftRef } from './store';

// A local receipt and a server acknowledgement are different. The SDK serializes its local
// mutations and cache reads: reading behind the write waits for its local transaction, even
// while the acknowledgement waits for the sync gate. Never reissue an offline write here.
export async function queueFieldEdit(
  client: FieldClient,
  ref: DraftRef,
  write: (db: Firestore) => Promise<void>,
): Promise<{ acknowledged: Promise<void> }> {
  const acknowledged = fieldWrite(client, write);
  // Observe the rejection from the start, including when marking failed before the SDK was called.
  // The caller still receives the original promise and must report a later server refusal.
  void acknowledged.catch(() => undefined);
  await Promise.race([
    acknowledged,
    getDocFromCache(doc(client.db, draftPath(ref))).then(() => undefined),
  ]);
  return { acknowledged };
}
