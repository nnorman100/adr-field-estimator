import type { Metadata } from 'next';
import { SignScreen } from './sign-screen';

// The homeowner's signing page (S5a-11b, docs/spec.md 2.5): /sign#token. The token is only in the
// address's fragment, which a browser never sends, so no server log holds it; the page reads it and
// sends it to the link routes in a header. No sign-in. Not indexed, no referrer, and the service
// worker does not keep it (sw/sw.js keeps only the field app's shell).
export const metadata: Metadata = {
  title: 'Review and sign your estimate · DryScope',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function SignPage() {
  return <SignScreen />;
}
