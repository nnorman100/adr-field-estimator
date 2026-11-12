import { loadSignInScreen } from '../load';
import { TeamScreen } from './team-screen';

export const metadata = { title: 'Team and invitations · DryScope' };

// The owner's "Team and invitations" screen, /sign-in/{sign-in address}/team. It lives under the
// company's sign-in address because the browser must know the company's sign-in tenant before it
// can use the saved sign-in; the screen itself still asks the server who is signed in, and every
// team call is checked there again.
export default async function CompanyTeamPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const { companyName, tenantId, config } = await loadSignInScreen(address);
  return <TeamScreen address={address} companyName={companyName} tenantId={tenantId} config={config} />;
}
