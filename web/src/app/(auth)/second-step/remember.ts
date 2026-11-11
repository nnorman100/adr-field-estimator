// This phone remembers that a person has a second step for a company, so that when the second step
// is reset (owner decision D9) the next sign-in can say so instead of showing a plain first-time
// setup. It is a convenience held only on this phone: the server decides who may sign in, and a
// person on another phone sees the ordinary setup screen. The key holds the company's sign-in
// tenant and the opaque account id (no email); the value is just "1". Storage can be missing or
// blocked (a private window), so every access is guarded.
const KEY_PREFIX = 'dryscope.secondStep.';

const keyFor = (tenantId: string, uid: string) => `${KEY_PREFIX}${tenantId}.${uid}`;

export function rememberSecondStep(tenantId: string, uid: string): void {
  try {
    window.localStorage.setItem(keyFor(tenantId, uid), '1');
  } catch {
    // Not remembered; the setup screen simply has no "was reset" notice next time.
  }
}

export function hadSecondStep(tenantId: string, uid: string): boolean {
  try {
    return window.localStorage.getItem(keyFor(tenantId, uid)) === '1';
  } catch {
    return false;
  }
}
