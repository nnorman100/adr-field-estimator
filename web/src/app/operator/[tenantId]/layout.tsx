import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { parseBrowserSignInConfig } from '@/lib/config';
import { isOperatorTenantId } from '@/lib/operator/screens';
import { OperatorSession } from './operator-session';

export const metadata = { title: 'Operator · DryScope', robots: { index: false, follow: false } };

// The platform operator's screens (S3-15). The address carries the operator sign-in tenant's id,
// which the owner-run command prints (owner decision D6): an operator signs in to that tenant and
// nowhere else, and the server decides on every call whether the account is an active operator, so
// a wrong tenant in the address only fails to sign in. The page itself holds no company data; it
// is read by the signed-in operator through the operator routes.
export default async function OperatorLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  await connection();
  const { tenantId } = await params;
  if (!isOperatorTenantId(tenantId)) notFound();
  return (
    <OperatorSession tenantId={tenantId} config={parseBrowserSignInConfig(process.env)}>
      {children}
    </OperatorSession>
  );
}
