import { loadSignInScreen } from '../../../load';
import { ReviewScreen } from './review-screen';

export const metadata = { title: 'Review before signing · DryScope' };

// "Review before signing" for one job, /sign-in/{sign-in address}/jobs/{job id}/review (S5a-9): the
// estimate and the four documents of the job's submitted record. It lives beside Finish and review
// (S5a-8), under the company's sign-in address, for the same reason: the browser must know the
// company's sign-in tenant before it can use the saved sign-in. The server checks the sign-in, the
// job and the role again on every call, and every amount and sentence shown comes from it.
export default async function ReviewPage({ params }: { params: Promise<{ address: string; jobId: string }> }) {
  const { address, jobId } = await params;
  const { companyName, tenantId, config } = await loadSignInScreen(address);
  return <ReviewScreen address={address} companyName={companyName} tenantId={tenantId} config={config} jobId={jobId} />;
}
