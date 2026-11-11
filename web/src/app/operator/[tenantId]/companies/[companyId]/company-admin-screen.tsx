'use client';

import Link from 'next/link';
import { STATUS_LABELS } from '@/lib/operator/screens';
import { useOperator } from '../../operator-session';
import { Section } from '../../ui';
import { OwnerSection } from './owner-section';
import { SecondStepSection } from './second-step-section';
import { StatusSection } from './status-section';

// Company administration (S3-15): one company's status, owner and second steps. It holds no
// customer data and no control for any: jobs, estimates and prices are not shown or changed here.
// The company is found in the list the session already read, so opening this page writes no audit
// row; each change below writes exactly one on the server.
export function CompanyAdminScreen({ companyId }: { companyId: string }) {
  const { tenantId, companies } = useOperator();
  const company = companies.find((candidate) => candidate.id === companyId.toLowerCase());
  if (!company) {
    return (
      <>
        <h1 className="text-2xl font-semibold leading-tight">Company not found</h1>
        <p>
          <Link href={`/operator/${tenantId}`} className="font-medium underline underline-offset-4">
            Back to Companies
          </Link>
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold leading-tight">{company.name}</h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-medium">Status</dt>
        <dd>{STATUS_LABELS[company.status]}</dd>
        <dt className="font-medium">Sign-in address</dt>
        <dd>{company.signInSlug ?? 'none'}</dd>
        <dt className="font-medium">Sign-in tenant</dt>
        <dd>{company.tenantBound ? 'set' : 'not set yet'}</dd>
      </dl>
      <StatusSection company={company} />
      <OwnerSection company={company} />
      <SecondStepSection company={company} />
      <Section title="Team">
        <p>See who is on this company’s team. It is a read-only view, and each view is recorded.</p>
        <Link href={`/operator/${tenantId}/companies/${company.id}/team`} className="w-fit font-medium underline underline-offset-4">
          Open the team view
        </Link>
      </Section>
    </>
  );
}
