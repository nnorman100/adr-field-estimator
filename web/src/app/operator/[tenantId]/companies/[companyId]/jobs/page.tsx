import { SupportJobsScreen } from './support-jobs-screen';

// The read-only support view of a company's jobs (S5b-5).
export default async function SupportJobsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  return <SupportJobsScreen companyId={companyId} />;
}
