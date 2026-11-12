import { CompanyAdminScreen } from './company-admin-screen';

// Company administration: status, owner, second step.
export default async function CompanyAdminPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  return <CompanyAdminScreen companyId={companyId} />;
}
