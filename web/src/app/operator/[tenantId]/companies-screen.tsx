'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { platformPaths, type CompanyAnswer } from '@/lib/operator/client';
import { STATUS_LABELS } from '@/lib/operator/screens';
import { isSignInAddress } from '@/lib/sign-in/directory';
import { useOperator } from './operator-session';
import { Field, Section, StatusMessage } from './ui';
import { useAction } from './use-action';

// Companies (S3-15): every company with its status, and a form to create one. A new company has
// a name and a sign-in address (owner decision D5); its sign-in tenant is made by the owner-run
// command and bound afterwards, then its owner is invited from the company's own page.
export function CompaniesScreen() {
  const { tenantId, companies, applyCompany, call } = useOperator();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setCreated(null);
    setFormError(null);
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setFormError('Enter the company’s name.');
      return;
    }
    if (!isSignInAddress(address)) {
      setFormError('The sign-in address is lowercase letters, digits and hyphens, and starts and ends with a letter or digit.');
      return;
    }
    void action.run(
      () => call<CompanyAnswer>(platformPaths.companies(), { method: 'POST', body: { name: trimmed, signInSlug: address } }),
      (body) => {
        applyCompany(body.company);
        setCreated(`${body.company.name} was created.`);
        setName('');
        setAddress('');
      },
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold leading-tight">Companies</h1>
      {companies.length === 0 ? (
        <p>No companies yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {companies.map((company) => (
            <li key={company.id} className="flex flex-col gap-1 rounded-md border p-3">
              <p className="font-medium">{company.name}</p>
              <p className="text-sm">
                {STATUS_LABELS[company.status]} · Sign-in address: {company.signInSlug ?? 'none'} · Sign-in tenant:{' '}
                {company.tenantBound ? 'set' : 'not set yet'}
              </p>
              <Link
                href={`/operator/${tenantId}/companies/${company.id}`}
                className="w-fit font-medium underline underline-offset-4"
                aria-label={`Manage ${company.name}`}
              >
                Manage
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Section title="Add a company">
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <Field
            id="company-name"
            label="Company name"
            autoComplete="off"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            id="company-address"
            label="Sign-in address"
            hint="Lowercase letters, digits and hyphens. The company signs in at /sign-in/ followed by this."
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
            {formError ?? ''}
          </p>
          {action.problem}
          <StatusMessage text={created} />
          <Button type="submit" disabled={action.busy}>
            Add company
          </Button>
        </form>
      </Section>
    </>
  );
}
