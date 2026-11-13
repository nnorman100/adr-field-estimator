// The words of the Home Screen sheet and its notice (owner decision G8, D-025). The owner did not
// know the phrase "add to Home Screen", so the sheet says what it is and gives each tap. It is never
// called installing an app, and it never mentions a store: DryScope is a website, and the Home Screen
// icon is how an iPhone keeps a website's saved work. Plain strings, so the tests can import them.

export const HOME_SCREEN_TITLE = 'Save DryScope to your Home Screen';
export const HOME_SCREEN_WHY =
  'To work with no signal, put DryScope on your Home Screen, the screen with your apps. Safari erases what a website saves after about a week without a visit, including photos and notes not yet sent. A website saved to the Home Screen is not erased.';
export const HOME_SCREEN_STEPS = [
  'Tap the Share button in the Safari toolbar (the square with an arrow pointing up).',
  'Scroll down and tap Add to Home Screen.',
  'Tap Add.',
  'Open DryScope from the new icon on your Home Screen, and sign in there.',
] as const;
export const HOME_SCREEN_HELP =
  'Do this before you start a job. The icon keeps its own saved data, so DryScope opened from it starts signed out. Until then DryScope in Safari works only while you have signal.';
export const HOME_SCREEN_NOTICE = 'With no signal, DryScope works only from your Home Screen.';
