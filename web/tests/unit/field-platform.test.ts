import { describe, expect, it } from 'vitest';
import { fieldSurface, offlineCaptureAllowed } from '../../src/lib/field/platform';

// Where the field app is running, for the Home Screen rule (D-025, docs/plans/S6.md section 12):
// offline capture on an iPhone needs DryScope opened from its Home Screen icon.
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1';
// iPadOS asks for the desktop site by default and then reports a Mac.
const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';
const MAC = IPAD_AS_MAC;
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const tab = { standalone: false };
const icon = { standalone: true };

describe('where the field app is running', () => {
  it('is an iPhone browser tab for Safari and for the other iPhone browsers', () => {
    expect(fieldSurface({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5, ...tab })).toBe('ios-tab');
    expect(fieldSurface({ userAgent: IPHONE_CHROME, platform: 'iPhone', maxTouchPoints: 5, ...tab })).toBe('ios-tab');
  });

  it('is an iPad tab, including an iPad that asks for the desktop site', () => {
    expect(fieldSurface({ userAgent: IPAD, platform: 'iPad', maxTouchPoints: 5, ...tab })).toBe('ios-tab');
    expect(fieldSurface({ userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 5, ...tab })).toBe('ios-tab');
  });

  it('is the Home Screen icon when it was opened from there', () => {
    expect(fieldSurface({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5, ...icon })).toBe('ios-icon');
    expect(fieldSurface({ userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 5, ...icon })).toBe('ios-icon');
  });

  it('is neither for Android, a Mac with no touch screen and Windows', () => {
    expect(fieldSurface({ userAgent: ANDROID, platform: 'Linux armv81', maxTouchPoints: 5, ...tab })).toBe('other');
    expect(fieldSurface({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0, ...tab })).toBe('other');
    expect(fieldSurface({ userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 0, ...tab })).toBe('other');
  });

  it('is never an iPhone tab when an Android or desktop browser is installed to its home screen', () => {
    expect(fieldSurface({ userAgent: ANDROID, platform: 'Linux armv81', maxTouchPoints: 5, ...icon })).toBe('other');
    expect(fieldSurface({ userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 0, ...icon })).toBe('other');
  });
});

describe('offline capture', () => {
  it('is refused only in an iPhone browser tab', () => {
    expect(offlineCaptureAllowed('ios-tab')).toBe(false);
    expect(offlineCaptureAllowed('ios-icon')).toBe(true);
    expect(offlineCaptureAllowed('other')).toBe(true);
  });

  it('waits until the page knows where it is running', () => {
    expect(offlineCaptureAllowed(null)).toBe(false);
  });
});
