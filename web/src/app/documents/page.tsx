import type { Metadata } from 'next';
import { DocumentsScreen } from './documents-screen';

// Your signed estimate documents (S5a-11b, docs/spec.md 2.5): /documents#token, read-only, for 30
// days or until the company revokes the link. The token is only in the address's fragment and goes to
// the link routes in a header. No sign-in. Not indexed, no referrer, not kept for offline use.
export const metadata: Metadata = {
  title: 'Your signed estimate documents · DryScope',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function DocumentsPage() {
  return <DocumentsScreen />;
}
