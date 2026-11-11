import { isSignInAddress } from './directory';

// The phone remembers the last company sign-in address it opened (owner decision D5), so the app's
// start page can go straight to it. It is the address only, never a sign-in: signing out leaves it.
// Storage can be missing or blocked (a private window), so every access is guarded.
const KEY = 'dryscope.signInAddress';

export function rememberSignInAddress(address: string): void {
  if (!isSignInAddress(address)) return;
  try {
    window.localStorage.setItem(KEY, address);
  } catch {
    // Not remembered; the link still works.
  }
}

export function rememberedSignInAddress(): string | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return isSignInAddress(value) ? value : null;
  } catch {
    return null;
  }
}
