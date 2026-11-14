import { loadSignInScreen } from '../load';
import { PricesScreen } from './prices-screen';

export const metadata = { title: 'Prices · DryScope' };

// The company's Prices page (S4-8), /sign-in/{sign-in address}/prices: the owner edits and publishes
// the company's own prices; estimators and office staff read the published ones. It lives under the
// company's sign-in address, as the team and company settings screens do, because the browser must
// know the company's sign-in tenant before it can use the saved sign-in. With the company's
// price_books switch off it shows nothing about prices, and every prices call is checked again on the
// server.
export default async function PricesPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const { companyName, tenantId, config } = await loadSignInScreen(address);
  return <PricesScreen address={address} companyName={companyName} tenantId={tenantId} config={config} />;
}
