import { SupportTeamScreen } from './support-team-screen';

// The read-only support view of a company's team.
export default async function SupportTeamPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  return <SupportTeamScreen companyId={companyId} />;
}
