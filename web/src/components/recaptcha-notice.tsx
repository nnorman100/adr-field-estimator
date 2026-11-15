import { appCheckSettings } from '@/lib/app-check-client';
import type { BrowserSignInConfig } from '@/lib/config';

// The line Google asks for when the reCAPTCHA badge is hidden (globals.css hides it), in Google's
// own words: "This site is protected by reCAPTCHA." (docs.cloud.google.com/recaptcha/docs/faq,
// "I'd like to hide the reCAPTCHA badge"). Shown on the sign-in screens while App Check, which runs
// reCAPTCHA Enterprise, is set up (TC-5); nothing is shown while it is not. Full-contrast text, so
// the line stays readable at 390 px and in the axe check.
export function RecaptchaNotice({ config }: { config: BrowserSignInConfig }) {
  if (!appCheckSettings(config)) return null;
  return <p className="text-sm text-foreground">This site is protected by reCAPTCHA.</p>;
}
