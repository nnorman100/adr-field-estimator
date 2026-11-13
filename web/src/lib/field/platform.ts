// Where the field app is running, for the Home Screen rule (owner decision G8, D-025; docs/plans/S6.md
// section 12). Safari deletes what a website keeps on an iPhone after about 7 days without a visit,
// unsent offline photos and notes included, but not for a site saved to the Home Screen. So on an
// iPhone, offline capture is allowed only when DryScope was opened from its Home Screen icon. In a
// Safari tab the field screens work online only. Android and desktop browsers are not limited.

export type FieldSurface =
  // An iPhone or iPad browser tab (every browser on them is WebKit, with the same 7-day limit).
  | 'ios-tab'
  // An iPhone or iPad, opened from the Home Screen icon.
  | 'ios-icon'
  // Anything else: Android, a computer.
  | 'other';

export type PlatformFacts = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  // Opened from a Home Screen icon: `display-mode: standalone`, or `navigator.standalone` on iOS.
  standalone: boolean;
};

export function fieldSurface(facts: PlatformFacts): FieldSurface {
  // An iPad that asks for the desktop site calls itself a Mac, but a Mac has no touch screen.
  const apple =
    /iPhone|iPad|iPod/.test(facts.userAgent) || (facts.platform === 'MacIntel' && facts.maxTouchPoints > 1);
  if (!apple) return 'other';
  return facts.standalone ? 'ios-icon' : 'ios-tab';
}

// `null` is the server and the first client render, before the page knows; nothing is captured until
// it does, so a capture screen never opens for a moment on a phone that must not have it.
export function offlineCaptureAllowed(surface: FieldSurface | null): boolean {
  return surface === 'ios-icon' || surface === 'other';
}

export function readFieldSurface(): FieldSurface {
  return fieldSurface({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  });
}
