'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { BrowserSignInConfig } from '@/lib/config';
import { canReadAiUsage } from '@/lib/ai/usage-screen';
import { belongsTo, callApi, companyAuth } from '@/lib/firebase-client';
import { signOutOnRefusal } from '@/lib/field/sign-out';
import type { LockReason } from '@/lib/field/unsent';
import { pricesAccess } from '@/lib/prices/screen';
import { profileView, signedInProfileManager } from '@/lib/profile/screen';
import type { ProfileView } from '@/lib/profile/service';
import { endsSession, meOutcome } from '@/lib/sign-in/outcome';
import { FocusedPanel } from '../../../focused-panel';
import { failedSignOut, WorkNotSecured } from '../work-not-secured';
import { Panel } from '../../../panel';
import { CompanyForm } from './company-form';

export type CompanyScreenProps = {
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
  | { name: 'unavailable' }
  | { name: 'not-secured' }
  | { name: 'ready'; user: User; companyId: string; profile: ProfileView; aiUsage: boolean; prices: boolean };

export function CompanyScreen(props: CompanyScreenProps) {
  if (!props.config) {
    return (
      <Panel title="Company settings">
        <p>Sign-in is not set up here yet. Try again later.</p>
      </Panel>
    );
  }
  return <CompanySettings key={props.tenantId} {...props} config={props.config} />;
}

function CompanySettings({
  address,
  companyName,
  tenantId,
  config,
}: CompanyScreenProps & { config: BrowserSignInConfig }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const authRef = useRef<Auth | null>(null);

  useEffect(() => {
    const auth = companyAuth({ config, tenantId });
    authRef.current = auth;
    // The latest sign-in wins: an answer for a user who has since signed out is dropped.
    const stale = (user: User) => authRef.current?.currentUser !== user;
    const signOutOrUnavailable = (refusal: LockReason) =>
      signOutOnRefusal(auth, tenantId, config, refusal).catch((error) => setPhase(failedSignOut(error)));

    async function open(user: User) {
      setPhase({ name: 'checking' });
      const me = await callApi(user, '/api/me');
      if (stale(user)) return;
      const outcome = meOutcome(me.status, me.body);
      if (endsSession(outcome)) {
        await signOutOrUnavailable(outcome.kind);
        return;
      }
      if (outcome.kind === 'unavailable') return setPhase({ name: 'unavailable' });
      if (outcome.kind !== 'signed-in') return setPhase({ name: 'finish-sign-in' });
      const member = signedInProfileManager(me.body);
      if (!member) return setPhase({ name: 'unavailable' });
      // Not the owner: the profile is never requested, so nothing of it reaches this phone.
      if (!member.canManageProfile) return setPhase({ name: 'not-owner' });
      const answer = await callApi(user, `/api/companies/${member.companyId}/profile`);
      if (stale(user)) return;
      const profile = answer.status === 200 ? profileView(answer.body) : null;
      if (!profile) return setPhase({ name: 'unavailable' });
      setPhase({
        name: 'ready',
        user,
        companyId: member.companyId,
        profile,
        aiUsage: canReadAiUsage(me.body),
        // The Prices page is offered only while the company's price_books switch is on.
        prices: pricesAccess(me.body)?.canRead === true,
      });
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
        <FocusedPanel title="Company settings">
          <p role="status">Checking your sign-in…</p>
        </FocusedPanel>
      );
    case 'signed-out':
      return (
        <FocusedPanel title="Sign in to change the company settings">
          <p>The company settings are for the owner of {companyName}. Sign in first.</p>
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
          <p>Only the owner of {companyName} can see and change the company settings.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'not-secured':
      return <WorkNotSecured />;
    case 'unavailable':
      return (
        <FocusedPanel title="We could not open the company settings">
          <p>Check your connection, then try again.</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
          {signInLink}
        </FocusedPanel>
      );
    case 'ready':
      return (
        <CompanyForm
          address={address}
          user={phase.user}
          companyId={phase.companyId}
          initial={phase.profile}
          showAiUsage={phase.aiUsage}
          showPrices={phase.prices}
        />
      );
  }
}
