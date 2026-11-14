import { Button } from '@/components/ui/button';
import { WorkNotSecuredError } from '@/lib/field/sign-out';
import { FocusedPanel } from '../../focused-panel';

// A sign-out the app had to make could not first save the refusal on this phone (S6-3b): nothing
// was signed out or removed, nothing of the company shows, and trying again repeats it.
export const NOT_SECURED_TITLE = 'We couldn’t secure your saved work';
export const NOT_SECURED_TEXT = 'This phone could not save what keeps your unsent work safe. Nothing was removed. Try again.';

// The screen a failed sign-out leads to: this one when the refusal could not be saved, otherwise
// the screen's own "could not open".
export const failedSignOut = (error: unknown): { name: 'not-secured' } | { name: 'unavailable' } =>
  error instanceof WorkNotSecuredError ? { name: 'not-secured' } : { name: 'unavailable' };

export function WorkNotSecured() {
  return (
    <FocusedPanel title={NOT_SECURED_TITLE}>
      <p>{NOT_SECURED_TEXT}</p>
      <Button onClick={() => window.location.reload()}>Try again</Button>
    </FocusedPanel>
  );
}
