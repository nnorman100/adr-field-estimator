// The words of the field shell's phone-storage screens (S6-3). Plain strings, so the tests can
// import them. Never "install": DryScope is a website kept on the Home Screen (D-025).

export const KEEP_TITLE = 'Keep jobs on this phone?';
export const KEEP_WHAT =
  'DryScope can keep the jobs you open, and the changes you make, on this phone, so you can keep working with no signal. Only do this on a phone that is yours or your company’s.';
export const KEEP_LIMITS =
  'What is kept here cannot be erased from the office or remotely. Signing out removes it, unless you choose to keep work that has not been sent yet.';
export const KEEP_YES = 'Keep jobs on this phone';
export const KEEP_NO = 'Online only';
export const ONLINE_ONLY_NOTICE = 'Jobs are not kept on this phone. You need signal to work.';

export const ONE_WINDOW_TITLE = 'Open DryScope in one window';
export const ONE_WINDOW_TEXT =
  'DryScope is already open in another window or tab on this phone. Close the others and use that one, so your changes are not lost.';

export const NO_LOCK_TITLE = 'This browser can’t keep work offline';
export const NO_LOCK_TEXT =
  'DryScope needs an up-to-date browser to keep jobs on this phone safely. Update Safari or Chrome, or open DryScope from the icon on your Home Screen.';

export const REOPEN_TITLE = 'Reopen the app';
export const REOPEN_TEXT =
  'This phone’s storage did not answer, and it holds changes that have not been sent yet. Close DryScope completely and open it again. Nothing has been lost.';

export const ONLINE_ONCE_TITLE = 'Open the app once online to continue';
export const ONLINE_ONCE_TEXT =
  'You signed in on this phone too long ago to keep working with no signal. Your work is kept. When you have signal, open DryScope and sign in if asked.';

export const RENEWING_TEXT = 'Waiting for access to renew. Your changes stay on this phone until then.';
export const CHECKING_PHONE_TEXT = 'Checking this phone. Your changes stay on this phone until then.';

export const LOCKED_DISABLED_TEXT =
  'Your access has been turned off, so nothing is sent. Your changes stay on this phone. When the owner turns your access back on, sign in again if asked, and they are sent.';
export const LOCKED_INACTIVE_TEXT =
  'This company is not active, so nothing is sent. Your changes stay on this phone, and are sent if the company is turned back on.';
export const LOCKED_SIGN_IN_TEXT =
  'Sign in again to send your changes. They stay on this phone until you do.';

// The same screens for a cache that keeps nothing (Online only, an iPhone browser tab, the memory
// fallback): changes not sent yet live only in this window, so nothing promises they are kept.
export const IN_WINDOW_ONLY = 'Changes not sent yet are only in this window: they are lost if you close it or leave DryScope.';
export const ONLINE_ONCE_MEMORY_TEXT = `You signed in on this phone too long ago to keep working with no signal. ${IN_WINDOW_ONLY}`;
export const RENEWING_MEMORY_TEXT = `Waiting for access to renew. ${IN_WINDOW_ONLY}`;
export const CHECKING_PHONE_MEMORY_TEXT = `Checking this phone. ${IN_WINDOW_ONLY}`;
export const LOCKED_DISABLED_MEMORY_TEXT = `Your access has been turned off, so nothing is sent. ${IN_WINDOW_ONLY}`;
export const LOCKED_INACTIVE_MEMORY_TEXT = `This company is not active, so nothing is sent. ${IN_WINDOW_ONLY}`;
export const LOCKED_SIGN_IN_MEMORY_TEXT = `Sign in again to send your changes. ${IN_WINDOW_ONLY} Signing in leaves this window.`;

export const REMOVED_TEXT =
  'The changes kept on this phone were removed, because your access stayed turned off for 30 days.';
// Past the same limit, before the server has confirmed it (decision 010): nothing of it shows.
export const HIDDEN_TEXT =
  'The changes kept on this phone are hidden, because your access stayed turned off for 30 days. With signal, DryScope asks your company: they are removed if your access is still off, and shown again once you can sign in.';
