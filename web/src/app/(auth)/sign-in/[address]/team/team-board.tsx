'use client';

import type { User } from 'firebase/auth';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { callApi } from '@/lib/firebase-client';
import {
  fullTeam,
  invitationStatusText,
  isSignInAgain,
  otherStaffRole,
  roleLabel,
  stillOpenLink,
  teamErrorMessage,
} from '@/lib/team/screen';
import type { InvitationView, MemberView, TeamView } from '@/lib/team/service';
import { FocusedPanel } from '../../../focused-panel';

type Team = Extract<TeamView, { view: 'full' }>;

// The owner's team and invitations, on one screen at phone width: invite someone, the members, the
// invitations. Every change is one call to the team API, followed by reading the list again, so the
// screen always shows what the server holds. Each button's name ends with whom it is for.
export function TeamBoard({
  address,
  companyName,
  user,
  companyId,
  initial,
  onSignInAgain,
}: {
  address: string;
  companyName: string;
  user: User;
  companyId: string;
  initial: Team;
  onSignInAgain: () => Promise<void>;
}) {
  const [team, setTeam] = useState<Team>(initial);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'estimator' | 'office'>('estimator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The link of the invitation just made or resent, for the owner to copy while it is still open.
  const [link, setLink] = useState<{ id: string; email: string; url: string } | null>(null);

  const base = `/api/companies/${companyId}`;

  async function reload() {
    const answer = await callApi(user, `${base}/team`);
    const next = answer.status === 200 ? fullTeam(answer.body) : null;
    if (next) {
      setTeam(next);
      setLink((current) => stillOpenLink(current, next.invitations));
    } else setError('The change was made, but the list could not be refreshed. Reload the page.');
  }

  // One change: call, then show what the server holds. `done` reads the answer of a call that
  // returns something to show (the link).
  async function change(path: string, init: { method?: string; json?: unknown }, done?: (body: unknown) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const answer = await callApi(user, path, init);
      if (answer.status < 200 || answer.status >= 300) {
        setError(teamErrorMessage(answer.status, answer.body));
        setNeedsSignIn(isSignInAgain(answer.status, answer.body));
        return;
      }
      done?.(answer.body);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  function showLink(body: unknown) {
    const { link: path, invitation } = (body ?? {}) as { link?: unknown; invitation?: { id?: unknown; email?: unknown } };
    if (typeof path === 'string' && typeof invitation?.id === 'string' && typeof invitation.email === 'string') {
      setLink({ id: invitation.id, email: invitation.email, url: `${window.location.origin}${path}` });
    }
  }

  return (
    <FocusedPanel title="Team and invitations">
      <p>
        The people of {companyName}.{' '}
        <Link href={`/sign-in/${address}`} className="underline">
          Back to your sign-in page
        </Link>
      </p>
      <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
        {error ?? ''}
      </p>
      {needsSignIn ? <Button onClick={() => void onSignInAgain()}>Sign in again</Button> : null}
      <p role="status" className="text-sm empty:hidden">
        {notice ?? ''}
      </p>

      <section aria-labelledby="invite-heading" className="flex flex-col gap-3">
        <h2 id="invite-heading" className="text-lg font-semibold">
          Invite someone
        </h2>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const invited = email.trim().toLowerCase();
            void change(`${base}/invitations`, { method: 'POST', json: { email: invited, role } }, (body) => {
              setEmail('');
              showLink(body);
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-email" className="font-medium">
              Email address to invite
            </label>
            <Input
              id="invite-email"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">Role</legend>
            {(['estimator', 'office'] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-3">
                <input type="radio" name="invite-role" className="size-5" checked={role === value} onChange={() => setRole(value)} />
                {roleLabel(value)}
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={busy}>
            Create invitation
          </Button>
        </form>
        {link ? <InvitationLink email={link.email} url={link.url} onCopied={setNotice} /> : null}
      </section>

      <section aria-labelledby="members-heading" className="flex flex-col gap-3">
        <h2 id="members-heading" className="text-lg font-semibold">
          Members
        </h2>
        <ul className="flex flex-col gap-3">
          {team.members.map((member) => (
            <MemberRow key={member.membershipId} member={member} busy={busy} base={base} change={change} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="invitations-heading" className="flex flex-col gap-3">
        <h2 id="invitations-heading" className="text-lg font-semibold">
          Invitations
        </h2>
        {team.invitations.length === 0 ? <p>No invitations.</p> : null}
        <ul className="flex flex-col gap-3">
          {team.invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              busy={busy}
              onResend={() => change(`${base}/invitations/${invitation.id}/resend`, { method: 'POST' }, showLink)}
              onCancel={() => change(`${base}/invitations/${invitation.id}/cancel`, { method: 'POST' })}
              onClear={() => change(`${base}/invitations/${invitation.id}/clear`, { method: 'POST' })}
            />
          ))}
        </ul>
      </section>
    </FocusedPanel>
  );
}

function who(member: Pick<MemberView, 'displayName' | 'email'>): string {
  return member.displayName ?? member.email;
}

const ROW = 'flex flex-col gap-2 rounded-md border border-input p-3';

function MemberRow({
  member,
  busy,
  base,
  change,
}: {
  member: MemberView;
  busy: boolean;
  base: string;
  change: (path: string, init: { method?: string; json?: unknown }) => Promise<void>;
}) {
  const name = who(member);
  const off = member.status === 'disabled';
  return (
    <li className={ROW}>
      <p className="font-medium">{name}</p>
      {member.displayName ? <p className="text-sm">{member.email}</p> : null}
      <p className="text-sm">
        {roleLabel(member.role)}
        {off ? ' · Turned off' : ''}
      </p>
      {member.role === 'owner' ? null : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              change(`${base}/members/${member.membershipId}`, { method: 'PATCH', json: { role: otherStaffRole(member.role) } })
            }
          >
            Change to {roleLabel(otherStaffRole(member.role)).toLowerCase()}
            <span className="sr-only"> for {name}</span>
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => change(`${base}/members/${member.membershipId}/${off ? 'enable' : 'disable'}`, { method: 'POST' })}
          >
            {off ? 'Turn on' : 'Turn off'}
            <span className="sr-only"> for {name}</span>
          </Button>
        </div>
      )}
    </li>
  );
}

function InvitationRow({
  invitation,
  busy,
  onResend,
  onCancel,
  onClear,
}: {
  invitation: InvitationView;
  busy: boolean;
  onResend: () => Promise<void>;
  onCancel: () => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const open = invitation.status === 'pending';
  const expired = invitation.status === 'expired';
  return (
    <li className={ROW}>
      <p className="font-medium">{invitation.email}</p>
      <p className="text-sm">
        {roleLabel(invitation.role)} · {invitationStatusText(invitation)}
      </p>
      <div className="flex flex-wrap gap-2">
        {open || expired ? (
          <Button variant="outline" disabled={busy} onClick={() => void onResend()}>
            Resend<span className="sr-only"> to {invitation.email}</span>
          </Button>
        ) : null}
        {open ? (
          <Button variant="outline" disabled={busy} onClick={() => void onCancel()}>
            Cancel<span className="sr-only"> for {invitation.email}</span>
          </Button>
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => void onClear()}>
            Clear<span className="sr-only"> for {invitation.email}</span>
          </Button>
        )}
      </div>
    </li>
  );
}

// There is no email service yet, so the owner sends the link themselves.
function InvitationLink({ email, url, onCopied }: { email: string; url: string; onCopied: (message: string) => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-input p-3">
      <p className="font-medium">Invitation for {email}</p>
      <p className="text-sm">Send them this link. It works for 7 days.</p>
      <label htmlFor="invitation-link" className="sr-only">
        Invitation link for {email}
      </label>
      <Input id="invitation-link" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
      <Button
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            onCopied('Link copied.');
          } catch {
            onCopied('Could not copy. Select the link and copy it by hand.');
          }
        }}
      >
        Copy link
      </Button>
    </div>
  );
}
