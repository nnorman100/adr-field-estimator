import { SupportJobScreen } from './support-job-screen';

// The read-only support view of one job: its record, signed agreement and evidence (S5b-5).
export default async function SupportJobPage({ params }: { params: Promise<{ companyId: string; jobId: string }> }) {
  const { companyId, jobId } = await params;
  return <SupportJobScreen companyId={companyId} jobId={jobId} />;
}
