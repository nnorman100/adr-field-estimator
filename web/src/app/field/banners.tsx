// The two status banners of the field shell (S6-2). Each sits in a live region that is always on
// the page, so a screen reader announces the words when they appear.

export const OFFLINE_TEXT = 'No signal: your work is saved on this phone';
export const NOT_SAVED_TEXT = 'Not saved on this phone';
// In an iPhone browser tab nothing is kept for later (Safari deletes it after about 7 days), so the
// promise above is not made there (owner decision G8, D-025).
export const ONLINE_ONLY_TEXT =
  'No signal: in Safari, DryScope works online only. Save it to your Home Screen to work with no signal.';

export function OfflineBanner({ offline, onlineOnly }: { offline: boolean; onlineOnly: boolean }) {
  return (
    <div role="status">
      {offline ? (
        <p className="border-b border-input bg-accent px-4 py-3 text-base font-medium">
          {onlineOnly ? ONLINE_ONLY_TEXT : OFFLINE_TEXT}
        </p>
      ) : null}
    </div>
  );
}

// Shown when this browser will not keep data on the phone (storage blocked, a private window, or,
// from S6-3, the Firestore cache falling back to memory). Work done now is lost when the page
// closes, so the banner says what to do about it.
export function NotSavedBanner({ unavailable }: { unavailable: boolean }) {
  return (
    <div role="alert">
      {unavailable ? (
        <div className="border-b border-input bg-accent px-4 py-3">
          <p className="text-base font-semibold">{NOT_SAVED_TEXT}</p>
          <p className="text-base">
            This browser is not keeping data on the phone, so work can be lost when you close the page. Turn off
            Private Browsing, or open DryScope from the icon on your Home Screen.
          </p>
        </div>
      ) : null}
    </div>
  );
}
