import type { BrowserSignInConfig } from '@/lib/config';
import { discardFieldWork, type FieldPerson } from '@/lib/field-db';
import { lockOutlived, noteUnlocked, outlivedLocks } from './unsent';

// Locked work past the 30-day limit (owner decision O5), where the sign-in page meets it (S6-3b).
// The field shell's gate removes its own person's work (field-sync.ts), but a sign-out the app made
// on a refusal removes the saved sign-in the shell starts from, so the shell never starts for that
// person again. The lock itself stays on the phone (unsent.ts keeps it apart from the saved
// sign-in), and the sign-in page, which every such sign-out leads to, acts on it: it removes the
// company's outlived work as it opens, and never lifts an outlived lock when the person gets back in.

// Removes the work of every person of this company whose lock outlived the limit on this phone. A
// field window open elsewhere holds that work and removes it itself; anything not removed now is
// tried again the next time.
export async function removeOutlivedWork(tenantId: string, config: BrowserSignInConfig, now = Date.now()): Promise<void> {
  for (const uid of outlivedLocks(tenantId, now)) {
    await discardFieldWork({ tenantId, uid, config }).catch(() => 'failed');
  }
}

// The server let this person in at sign-in. Their lock is lifted, so the work is sent, unless it
// outlived the limit: then the work is removed instead ('removed'), and when it cannot be (a field
// window open elsewhere, a storage failure) it stays locked ('locked'), never sent.
export async function letIn(person: FieldPerson, now = Date.now()): Promise<'unlocked' | 'removed' | 'locked'> {
  if (!lockOutlived(person.tenantId, person.uid, now)) {
    noteUnlocked(person.tenantId, person.uid);
    return 'unlocked';
  }
  const result = await discardFieldWork(person).catch(() => 'failed' as const);
  return result === 'discarded' ? 'removed' : 'locked';
}
