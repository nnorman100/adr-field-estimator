'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { BrowserSignInConfig } from '@/lib/config';
import { belongsTo, callApi, companyAuth } from '@/lib/firebase-client';
import { signOutOnRefusal, signOutOrShow, type FailedSignOut } from '@/lib/field/sign-out';
import type { LockReason } from '@/lib/field/unsent';
import { endsSession, meOutcome } from '@/lib/sign-in/outcome';
import { fullTeam, signedInMember } from '@/lib/team/screen';
import type { TeamView } from '@/lib/team/service';
import { FocusedPanel } from '../../../focused-panel';
import { WorkNotSecured } from '../work-not-secured';
import { Panel } from '../../../panel';
import { TeamBoard } from './team-board';

export type TeamScreenProps = {
  address: string;
  companyName: string;
  tenantId: string;
  // null when sign-in is not set up for this environment yet.
  config: BrowserSignInConfig | null;
};

type Phase =
  | { name: 'checking' }
  | { name: 'signed-out' }
  // Signed in, but not with a usable sign-in for this screen (unverified email, no membership, ...):
  // the company's sign-in page says what to do.
  | { name: 'finish-sign-in' }
  | { name: 'not-owner' }
  | FailedSignOut
  | { name: 'ready'; user: User; companyId: string; team: Extract<TeamView, { view: 'full' }> };

export function TeamScreen(props: TeamScreenProps) {
  if (!props.config) {
    return (
      <Panel title="Team and invitations">
        <p>Sign-in is not set up here yet. Try again later.</p>
      </Panel>
    );
  }
  return <CompanyTeam key={props.tenantId} {...props} config={props.config} />;
}

function CompanyTeam({ address, companyName, tenantId, config }: TeamScreenProps & { config: BrowserSignInConfig }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const authRef = useRef<Auth | null>(null);
  const router = useRouter();

  useEffect(() => {
    const auth = companyAuth({ config, tenantId });
    authRef.current = auth;
    // The latest sign-in wins: an answer for a user who has since signed out is dropped.
    const stale = (user: User) => authRef.current?.currentUser !== user;
    const signOutOrUnavailable = (refusal: LockReason, fromServer = false) =>
      signOutOrShow(() => signOutOnRefusal(auth, tenantId, config, refusal, fromServer), setPhase);

    async function open(user: User) {
      setPhase({ name: 'checking' });
      const me = await callApi(user, '/api/me');
      if (stale(user)) return;
      const outcome = meOutcome(me.status, me.body);
      if (endsSession(outcome)) {
        await signOutOrUnavailable(outcome.kind, true);
        return;
      }
      if (outcome.kind === 'unavailable') return setPhase({ name: 'unavailable' });
      if (outcome.kind !== 'signed-in') return setPhase({ name: 'finish-sign-in' });
      const member = signedInMember(me.body);
      if (!member) return setPhase({ name: 'unavailable' });
      // Not the owner: the team is never requested, so nothing of it reaches this phone.
      if (!member.canManageTeam) return setPhase({ name: 'not-owner' });
      const answer = await callApi(user, `/api/companies/${member.companyId}/team`);
      if (stale(user)) return;
      const team = answer.status === 200 ? fullTeam(answer.body) : null;
      if (!team) return setPhase({ name: 'unavailable' });
      setPhase({ name: 'ready', user, companyId: member.companyId, team });
    }

    return onAuthStateChanged(auth, (user) => {
      if (!user) return setPhase({ name: 'signed-out' });
      // This company's Auth instance only ever holds this tenant's sign-in.
      if (!belongsTo(user, tenantId)) return void signOutOrUnavailable('not-this-company');
      void open(user);
    });
  }, [config, tenantId]);

  const signInLink = (
    <Button asChild variant="outline">
      <Link href={`/sign-in/${address}`}>Go to the {companyName} sign-in page</Link>
    </Button>
  );

  switch (phase.name) {
    case 'checking':
      return (
        <FocusedPanel title="Team and invitations">
          <p role="status">Checking your sign-in…</p>
        </FocusedPanel>
      );
    case 'signed-out':
      return (
        <FocusedPanel title="Sign in to see your team">
          <p>The team screen is for the owner of {companyName}. Sign in first.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'finish-sign-in':
      return (
        <FocusedPanel title="Finish signing in first">
          <p>Your sign-in is not finished yet. The sign-in page shows the next step.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'not-owner':
      return (
        <FocusedPanel title="This screen is for the company owner">
          <p>Only the owner of {companyName} can see and change the team.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'not-secured':
      return <WorkNotSecured retry={phase.retry} />;
    case 'unavailable':
      return (
        <FocusedPanel title="We could not open the team">
          <p>Check your connection, then try again.</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
          {signInLink}
        </FocusedPanel>
      );
    case 'ready':
      return (
        <TeamBoard
          address={address}
          companyName={companyName}
          user={phase.user}
          companyId={phase.companyId}
          initial={phase.team}
          onSignInAgain={async () => {
            const auth = authRef.current;
            const toSignIn = () => router.push(`/sign-in/${address}`);
            return auth ? signOutOrShow(() => signOutOnRefusal(auth, tenantId, config, 'sign-in-again'), setPhase, toSignIn) : toSignIn();
          }}
        />
      );
  }
}
