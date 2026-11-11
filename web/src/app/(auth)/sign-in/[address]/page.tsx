import { loadSignInScreen } from './load';
import { SignInScreen } from './sign-in-screen';

export const metadata = { title: 'Sign in · DryScope' };

// A company's own sign-in page, /sign-in/{sign-in address} (owner decision D5).
export default async function CompanySignInPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <SignInScreen {...await loadSignInScreen(address)} />;
}
