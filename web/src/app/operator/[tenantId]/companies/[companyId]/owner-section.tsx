'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { platformPaths, type CompanyView, type OwnerAnswer } from '@/lib/operator/client';
import { useOperator } from '../../operator-session';
import { Field, Section, StatusMessage } from '../../ui';
import { useAction } from '../../use-action';

// Invite the company's first owner, or replace the owner (owner decision D11: by invitation link
// only; the operator copies it while no email service is set up). Replacing turns the current
// owner off and signs them out everywhere before the server answers. Both need a sign-in under 15
// minutes old, and the server decides; this form only asks.
export function OwnerSection({ company }: { company: CompanyView }) {
  const { call } = useOperator();
  const [mode, setMode] = useState<'first' | 'replace'>('first');
  const [email, setEmail] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [result, setResult] = useState<{ link: string; email: string; replaced: boolean } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const action = useAction();

  if (!company.tenantBound) {
    return (
      <Section title="Owner">
        <p>
          This company has no sign-in tenant yet, so an owner cannot be invited. The tenant is made by the owner-run
          command and bound to the company first.
        </p>
      </Section>
    );
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setResult(null);
    setCopied(null);
    const person = email.trim();
    void action.run(
      () => call<OwnerAnswer>(platformPaths.owner(company.id), { method: 'POST', body: { email: person, replace: mode === 'replace' } }),
      (body) => {
        // The link is a path on this app; the new owner opens it on this app's address.
        setResult({ link: `${window.location.origin}${body.link}`, email: person, replaced: body.replacedMembershipId !== null });
        setEmail('');
        setUnderstood(false);
      },
    );
  }

  function chooseMode(next: 'first' | 'replace') {
    setMode(next);
    setUnderstood(false);
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('Link copied.');
    } catch {
      setCopied('Could not copy. Select the link and copy it.');
    }
  }

  return (
    <Section title="Owner">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">What do you want to do?</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="owner-mode" className="mt-1" checked={mode === 'first'} onChange={() => chooseMode('first')} />
            <span>Invite the first owner</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="owner-mode" className="mt-1" checked={mode === 'replace'} onChange={() => chooseMode('replace')} />
            <span>Replace the owner</span>
          </label>
        </fieldset>
        <Field
          id="owner-email"
          label="New owner’s email"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {mode === 'replace' ? (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" required checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
            <span>I understand the current owner is turned off and signed out everywhere straight away.</span>
          </label>
        ) : null}
        {action.problem}
        <Button type="submit" disabled={action.busy}>
          {mode === 'replace' ? 'Replace owner' : 'Invite owner'}
        </Button>
      </form>
      {result ? (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p role="status">
            {result.replaced ? 'The previous owner is turned off and signed out. ' : ''}No email is sent yet. Send this link to{' '}
            {result.email} yourself; it works for 7 days.
          </p>
          <label htmlFor="owner-link" className="font-medium">
            Invitation link
          </label>
          <input
            id="owner-link"
            readOnly
            value={result.link}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button variant="outline" onClick={() => void copy(result.link)}>
            Copy link
          </Button>
          <StatusMessage text={copied} />
        </div>
      ) : null}
    </Section>
  );
}
