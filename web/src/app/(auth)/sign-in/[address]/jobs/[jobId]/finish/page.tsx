import { loadSignInScreen } from '../../../load';
import { FinishScreen } from './finish-screen';

export const metadata = { title: 'Finish and review · DryScope' };

// "Finish and review" for one job, /sign-in/{sign-in address}/jobs/{job id}/finish (S5a-8). It
// lives under the company's sign-in address for the same reason the team and company screens do:
// the browser must know the company's sign-in tenant before it can use the saved sign-in. The
// job's own screens (S5a-6) link here; the server checks the sign-in, the job and the role again on
// every call.
export default async function FinishPage({ params }: { params: Promise<{ address: string; jobId: string }> }) {
  const { address, jobId } = await params;
  const { companyName, tenantId, config } = await loadSignInScreen(address);
  return <FinishScreen address={address} companyName={companyName} tenantId={tenantId} config={config} jobId={jobId} />;
}
