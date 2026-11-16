// Job screens use only the person-scoped client the field shell already started. No second
// Firestore instance or independent /api/me request may bypass the sync gate.
import { onAuthStateChanged, type User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { companyAuth } from '@/lib/firebase-client';
import type { FieldClient } from '@/lib/field-db';
import type { DsMe } from './ds-me';

export type FieldSession = {
  user: User;
  db: Firestore;
  client: FieldClient;
  companyId: string;
  role: string;
  capabilities: string[];
  online: boolean;
  offlineCapture: boolean;
};

// Watches the company sign-in: a person app is only its in-memory mirror. The screens are
// opened after this answers for the expected uid, and close on a sign-out or a different person.
export function watchSignIn(saved: DsMe, uid: string, lost: () => void, ready?: () => void): () => void {
  const auth = companyAuth({ config: saved.config, tenantId: saved.tenantId });
  return onAuthStateChanged(auth, (user) => {
    if (user?.uid !== uid) lost();
    else ready?.();
  });
}
