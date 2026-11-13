import { loadSignInScreen } from '../load';
import { CompanyScreen } from './company-screen';

export const metadata = { title: 'Company settings · DryScope' };

// The owner's "Company settings" screen, /sign-in/{sign-in address}/company. It lives under the
// company's sign-in address for the same reason the team screen does: the browser must know the
// company's sign-in tenant before it can use the saved sign-in. The screen still asks the server who
// is signed in, and every profile call is checked there again.
export default async function CompanySettingsPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const { companyName, tenantId, config } = await loadSignInScreen(address);
  return (
    <CompanyScreen
      address={address}
      companyName={companyName}
      tenantId={tenantId}
      config={config}
    />
  );
}
