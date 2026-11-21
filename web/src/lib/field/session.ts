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
  // The signed-in person's id in this company (GET /api/me, `actor.id`): tells their own jobs and
  // field work from other people's. Required, never guessed (review decision D).
  actorId: string;
  role: string;
  capabilities: string[];
  readiness: boolean;
  // The company's AI summary draft switch (S7-6), from the live /api/me answer only.
  aiSummary: boolean;
  online: boolean;
  offlineCapture: boolean;
  // Has the sync gate ask the server who this person is now (see FieldContextValue.askAgain).
  askAgain: () => void;
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

// What the job screens need of the person to start: company, role and actor id. A saved sign-in
// written before the actor id was kept has the first two and not the third; it waits for one online
// check ('needs-check'); anything less is not a sign-in the screens can use (null).
export function sessionIdentity(me: { companyId: string | null; role: string | null; actorId: string | null }):
  | { companyId: string; role: string; actorId: string }
  | 'needs-check'
  | null {
  if (!me.companyId || !me.role) return null;
  return me.actorId ? { companyId: me.companyId, role: me.role, actorId: me.actorId } : 'needs-check';
}
