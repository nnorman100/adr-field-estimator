'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { platformPaths, fullTeam, type CompanyView, type MemberView, type ResetAnswer, type SupportTeamAnswer } from '@/lib/operator/client';
import { useOperator } from '../../operator-session';
import { roleName, Section, StatusMessage } from '../../ui';
import { useAction } from '../../use-action';

// Reset a person's second step (owner decision D9): after the operator has confirmed by phone that
// the person is who they say, their authenticator steps are removed and they are signed out; they
// set it up again at their next sign-in. Choosing the person reads the team, which the server
// records like any view of it.
export function SecondStepSection({ company }: { company: CompanyView }) {
  const { call } = useOperator();
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const loading = useAction();

  function choose() {
    setDone(null);
    void loading.run(
      () => call<SupportTeamAnswer>(platformPaths.team(company.id)),
      (body) => {
        const team = fullTeam(body.team);
        setMembers(team ? team.members : []);
      },
    );
  }

  return (
    <Section title="Second step">
      <p>
        Use this only after you have confirmed by phone that the person is who they say they are. They set up the
        authenticator again the next time they sign in.
      </p>
      <p className="text-sm">Listing the team here is recorded in the audit log, like the team view.</p>
      {members === null ? (
        <Button variant="outline" disabled={loading.busy} onClick={choose} className="w-fit">
          Choose a person
        </Button>
      ) : members.length === 0 ? (
        <p>This company has nobody to reset yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {members.map((member) => (
            <MemberReset key={member.membershipId} companyId={company.id} member={member} onDone={setDone} />
          ))}
        </ul>
      )}
      {loading.problem}
      <StatusMessage text={done} />
    </Section>
  );
}

function MemberReset({ companyId, member, onDone }: { companyId: string; member: MemberView; onDone: (message: string) => void }) {
  const { call } = useOperator();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const action = useAction();
  const who = member.displayName ? `${member.displayName} (${member.email})` : member.email;

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <p className="font-medium">
        {who}
      </p>
      <p className="text-sm">
        {roleName(member.role)} · {member.status === 'active' ? 'Active' : 'Turned off'}
      </p>
      {open ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(
              () => call<ResetAnswer>(platformPaths.resetSecondStep(companyId, member.membershipId), { method: 'POST', body: { confirmedBy: 'phone' } }),
              (body) => {
                setOpen(false);
                setConfirmed(false);
                onDone(
                  body.tellByPhone
                    ? `Second step reset for ${who}. No email is sent yet: tell them by phone that they must set it up again when they sign in.`
                    : `Second step reset for ${who}. They have been emailed.`,
                );
              },
            );
          }}
        >
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>I confirmed by phone that this is {member.displayName ?? member.email}.</span>
          </label>
          {action.problem}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={action.busy}>
              Reset second step
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={action.busy}
              onClick={() => {
                setOpen(false);
                setConfirmed(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="outline"
          className="w-fit"
          onClick={() => {
            action.clear();
            setOpen(true);
          }}
          aria-label={`Reset second step for ${who}`}>
          Reset second step
        </Button>
      )}
    </li>
  );
}
