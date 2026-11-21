// The digest a sign-in page's lookup carries when no database connection came free in time
// (security audit F5): load.ts throws it and error.tsx shows the busy message for it. Next keeps a
// thrown error's own digest, and only the digest reaches the browser.
export const SIGN_IN_BUSY = 'DRYSCOPE_SIGN_IN_BUSY';
