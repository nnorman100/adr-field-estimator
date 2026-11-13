// "Keep jobs on this phone?" (S6-3): Firestore's cache is not cleared between sessions, so a phone
// keeps job data only after the person says it is a phone they trust (the Firebase offline data
// guide asks the same: firebase.google.com/docs/firestore/manage-data/enable-offline). Asked once
// per phone and company; the answer is kept per company tenant, so a second company asks again.

export type KeepAnswer = 'keep' | 'online-only';

export const keepKey = (tenantId: string): string => `ds-keep/${tenantId}`;

// The answer given on this phone for this company, null when not asked yet (or unreadable: asked again).
export function keepAnswer(tenantId: string): KeepAnswer | null {
  try {
    const value = window.localStorage.getItem(keepKey(tenantId));
    return value === 'keep' || value === 'online-only' ? value : null;
  } catch {
    return null;
  }
}

export function saveKeepAnswer(tenantId: string, answer: KeepAnswer): void {
  try {
    window.localStorage.setItem(keepKey(tenantId), answer);
  } catch {
    // Asked again next time.
  }
}

// Asks the browser not to evict this origin's storage. Granted by the browser's own rules (a Home
// Screen app on iPhone; an engaged site on Chrome); a refusal changes nothing else.
export async function askToPersist(): Promise<boolean> {
  try {
    const storage = navigator.storage;
    if (!storage?.persist) return false;
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
