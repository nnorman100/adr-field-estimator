'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { fullTeam, platformPaths, type SupportTeamAnswer } from '@/lib/operator/client';
import { isSignInAgainCode, operatorErrorMessage, STATUS_LABELS } from '@/lib/operator/screens';
import { useOperator } from '../../../operator-session';
import { ErrorMessage, roleName, Section } from '../../../ui';

type Loaded = { answer: SupportTeamAnswer & { team: Extract<SupportTeamAnswer['team'], { view: 'full' }> } };

// The read-only support view of a company's team (S3-15). It shows who is on the team and which
// invitations are open, and nothing can be changed from it: no button or field here writes
// anything, and the customer's jobs, estimates and prices are not part of it. The server writes
// one audit row for each time it is opened.
export function SupportTeamScreen({ companyId }: { companyId: string }) {
  const { tenantId, call } = useOperator();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = teamPath(companyId);
  // One read per opening: React may run an effect twice in development, and each read is audited.
  const started = useRef(false);

  useEffect(() => {
    if (path === null || started.current) return;
    started.current = true;
    void (async () => {
      const result = await call<SupportTeamAnswer>(path);
      if (!result.ok) {
        setError(isSignInAgainCode(result.code) ? 'Sign in again to view this team.' : operatorErrorMessage(result.code));
        return;
      }
      const team = fullTeam(result.body.team);
      if (!team) {
        setError(operatorErrorMessage('unavailable'));
        return;
      }
      setLoaded({ answer: { ...result.body, team } });
    })();
  }, [call, path]);

  const back = (
    <Link href={`/operator/${tenantId}/companies/${companyId}`} className="w-fit font-medium underline underline-offset-4">
      Back to company
    </Link>
  );

  if (path === null) {
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

  if (!loaded) {
    return (
      <>
        <h1 className="text-2xl font-semibold leading-tight">Team</h1>
        {error ? <ErrorMessage text={error} /> : <p role="status">Loading the team…</p>}
        {back}
      </>
    );
  }

  const { company, team } = loaded.answer;
  return (
    <>
      <h1 className="text-2xl font-semibold leading-tight">{company.name}: team</h1>
      <p className="text-sm">
        Read-only support view. Company status: {STATUS_LABELS[company.status].toLowerCase()}. Opening this view is
        recorded in the audit log.
      </p>
      <Section title="Members">
        {team.members.length === 0 ? (
          <p>No members yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {team.members.map((member) => (
              <li key={member.membershipId} className="flex flex-col gap-1 rounded-md border p-3">
                <p className="font-medium">{member.displayName ?? member.email}</p>
                {member.displayName ? <p className="text-sm">{member.email}</p> : null}
                <p className="text-sm">
                  {roleName(member.role)} · {member.status === 'active' ? 'Active' : 'Turned off'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Invitations">
        {team.invitations.length === 0 ? (
          <p>No invitations.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {team.invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-col gap-1 rounded-md border p-3">
                <p className="font-medium">{invitation.email}</p>
                <p className="text-sm">
                  {roleName(invitation.role)} · {invitation.status}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {back}
    </>
  );
}

function teamPath(companyId: string): string | null {
  try {
    return platformPaths.team(companyId);
  } catch {
    return null;
  }
}
