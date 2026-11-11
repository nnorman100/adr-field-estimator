import { notFound } from 'next/navigation';
import { loadSignInScreen } from '../../load';
import { SignInScreen } from '../../sign-in-screen';

export const metadata = { title: 'Sign in · DryScope' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The link an owner copies for an invitation (S3-10): the company's sign-in page, opened for an
// invited person, who usually sets their own password first. Accepting the invitation is S3-16.
export default async function InvitationSignInPage({
  params,
}: {
  params: Promise<{ address: string; invitationId: string }>;
}) {
  const { address, invitationId } = await params;
  if (!UUID.test(invitationId)) notFound();
  return <SignInScreen {...await loadSignInScreen(address, invitationId.toLowerCase())} />;
}
