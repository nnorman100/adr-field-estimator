import type { BrowserSignInConfig } from '@/lib/config';
import { discardFieldWork, type FieldPerson } from '@/lib/field-db';
import { meKey } from './ds-me';
import { lockOutlived, noteLocked, noteUnlocked, outlivedLocks, type LockReason } from './unsent';

// Locked work past the 30-day limit (owner decision O5), wherever the phone meets it (S6-3b). A
// sign-out the app makes on a refusal removes the saved sign-in (ds-me) the field shell starts
// from, so nothing that removal leaves behind may be needed to remove the work later. The lock
// lives in the unsent-work mark (unsent.ts), apart from ds-me, and every lock is saved here with
// the company's public browser settings, the only thing that names the person's field database:
// no email, no token, no field values. runRetention acts on both at every entry point (the field
// shell, signed in or not; the gate's checks; the sign-in page).

const CLEANUP_PREFIX = 'ds-retain/';
export const cleanupKey = (tenantId: string): string => `${CLEANUP_PREFIX}${tenantId}`;

// Saves what removing this company's locked work needs, for when no saved sign-in is left. False
// when it could not be saved.
export function keepCleanupContext(tenantId: string, config: BrowserSignInConfig): boolean {
  const { apiKey, authDomain, projectId, authEmulatorUrl, firestoreDatabaseId, firestoreEmulatorUrl } = config;
  try {
    window.localStorage.setItem(
      cleanupKey(tenantId),
      JSON.stringify({ apiKey, authDomain, projectId, authEmulatorUrl, firestoreDatabaseId, firestoreEmulatorUrl }),
    );
    return true;
  } catch {
    return false;
  }
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function parseContext(raw: string | null): BrowserSignInConfig | null {
  try {
    const value = JSON.parse(raw ?? 'null') as Record<string, unknown> | null;
    if (value === null || typeof value !== 'object') return null;
    const { apiKey, authDomain, projectId, authEmulatorUrl, firestoreDatabaseId, firestoreEmulatorUrl } = value;
    const optional = (field: unknown) => field === undefined || field === null || text(field);
    if (!text(apiKey) || !text(authDomain) || !text(projectId)) return null;
    if (!optional(authEmulatorUrl) || !optional(firestoreDatabaseId) || !optional(firestoreEmulatorUrl)) return null;
    return {
      apiKey,
      authDomain,
      projectId,
      authEmulatorUrl: text(authEmulatorUrl) ? authEmulatorUrl : null,
      ...(text(firestoreDatabaseId) ? { firestoreDatabaseId } : {}),
      ...(text(firestoreEmulatorUrl) ? { firestoreEmulatorUrl } : {}),
    };
  } catch {
    return null;
  }
}

function cleanupContexts(): { tenantId: string; config: BrowserSignInConfig }[] {
  const found: { tenantId: string; config: BrowserSignInConfig }[] = [];
  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(CLEANUP_PREFIX)) continue;
      const tenantId = key.slice(CLEANUP_PREFIX.length);
      const config = parseContext(storage.getItem(key));
      if (tenantId.length > 0 && !tenantId.includes('/') && config) found.push({ tenantId, config });
    }
  } catch {
    return [];
  }
  return found;
}

// The server refused this person (O5): their work is locked from now, and what removes it after 30
// days is saved first, so a lock is never saved without it. Returns when the refusals began, or
// null when either could not be saved.
export function lockWork(person: FieldPerson, reason: LockReason, now = Date.now()): number | null {
  if (!keepCleanupContext(person.tenantId, person.config)) return null;
  return noteLocked(person.tenantId, person.uid, reason, now);
}

// Removes the work of every person on this phone, in every company, whose lock outlived the limit,
// signed in or not. Without `lockHeld` a field window open elsewhere holds that work, and nothing
// is removed; `lockHeld` is for the field window itself, and `skip` (a meKey) is the person whose
// client that window runs, whose own gate removes their work. A mark that cannot be read never
// counts. Returns who was removed (meKey); the rest is tried next time.
export async function runRetention(now = Date.now(), { lockHeld = false, skip = '' } = {}): Promise<string[]> {
  const removed: string[] = [];
  for (const { tenantId, config } of cleanupContexts()) {
    for (const uid of outlivedLocks(tenantId, now)) {
      if (meKey(tenantId, uid) === skip) continue;
      const result = await discardFieldWork({ tenantId, uid, config }, { lockHeld }).catch(() => 'failed' as const);
      if (result === 'discarded') removed.push(meKey(tenantId, uid));
    }
  }
  return removed;
}

// Calls `retain` each time the page is shown again (made visible, or brought back from the
// back-forward cache), the foreground entry points where locked work may have outlived the limit
// while the page was away. Returns what stops it.
export function whenShownAgain(retain: () => void): () => void {
  const shown = () => {
    if (document.visibilityState === 'visible') retain();
  };
  document.addEventListener('visibilitychange', shown);
  window.addEventListener('pageshow', shown);
  return () => {
    document.removeEventListener('visibilitychange', shown);
    window.removeEventListener('pageshow', shown);
  };
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
