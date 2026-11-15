'use client';

import type { Auth, User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { BrowserSignInConfig } from '@/lib/config';
import { belongsTo, callApi, companyAuth } from '@/lib/firebase-client';
import { signInOf, signOutOnRefusal, signOutOrShow, type FailedSignOut, type SignIn } from '@/lib/field/sign-out';
import type { LockReason } from '@/lib/field/unsent';
import { pricesAccess, pricesView, type OwnerPrices, type ReaderPrices } from '@/lib/prices/screen';
import { endsSession, meOutcome } from '@/lib/sign-in/outcome';
import { FocusedPanel } from '../../../focused-panel';
import { WorkNotSecured } from '../work-not-secured';
import { Panel } from '../../../panel';
import { ReadOnlyItems } from './price-list';
import { PricesEditor } from './prices-editor';
import { RoomPays } from './room-pays';

export type PricesScreenProps = {
  address: string;
  companyName: string;
  tenantId: string;
  // null when sign-in is not set up for this environment yet.
  config: BrowserSignInConfig | null;
};

type Phase =
  | { name: 'checking' }
  | { name: 'signed-out' }
  | { name: 'finish-sign-in' }
  // The company's prices are not open to this sign-in: the price_books switch is off for the
  // company (or the role holds no prices key). Nothing about prices is requested or shown.
  | { name: 'hidden' }
  | FailedSignOut
  | { name: 'owner'; user: User; prices: OwnerPrices }
  | { name: 'reader'; prices: ReaderPrices };

export function PricesScreen(props: PricesScreenProps) {
  if (!props.config) {
    return (
      <Panel title="Prices">
        <p>Sign-in is not set up here yet. Try again later.</p>
      </Panel>
    );
  }
  return <CompanyPrices key={props.tenantId} {...props} config={props.config} />;
}

function CompanyPrices({ address, companyName, tenantId, config }: PricesScreenProps & { config: BrowserSignInConfig }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const authRef = useRef<Auth | null>(null);
  const router = useRouter();

  useEffect(() => {
    const auth = companyAuth({ config, tenantId });
    authRef.current = auth;
    // The latest sign-in wins: an answer for a user who has since signed out is dropped.
    const stale = (user: User) => authRef.current?.currentUser !== user;
    const signOutOrUnavailable = (refusal: LockReason, fromServer = false, from?: SignIn) =>
      signOutOrShow(() => signOutOnRefusal(auth, tenantId, config, refusal, fromServer, from), setPhase);

    async function open(user: User) {
      setPhase({ name: 'checking' });
      // The sign-in this check is for, kept as the request goes.
      const from = signInOf(user);
      const me = await callApi(user, '/api/me');
      if (stale(user)) return;
      const outcome = meOutcome(me.status, me.body);
      if (endsSession(outcome)) {
        await signOutOrUnavailable(outcome.kind, true, from);
        return;
      }
      if (outcome.kind === 'unavailable') return setPhase({ name: 'unavailable' });
      if (outcome.kind !== 'signed-in') return setPhase({ name: 'finish-sign-in' });
      const access = pricesAccess(me.body);
      if (!access) return setPhase({ name: 'unavailable' });
      if (!access.canRead) return setPhase({ name: 'hidden' });
      const answer = await callApi(user, '/api/prices');
      if (stale(user)) return;
      // 404: the switch went off since /api/me answered.
      if (answer.status === 404) return setPhase({ name: 'hidden' });
      const prices = answer.status === 200 ? pricesView(answer.body) : null;
      if (!prices) return setPhase({ name: 'unavailable' });
      setPhase(prices.view === 'owner' ? { name: 'owner', user, prices } : { name: 'reader', prices });
    }

    return onAuthStateChanged(auth, (user) => {
      if (!user) return setPhase({ name: 'signed-out' });
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
        <FocusedPanel title="Prices">
          <p role="status">Checking your sign-in…</p>
        </FocusedPanel>
      );
    case 'signed-out':
      return (
        <FocusedPanel title="Sign in to see the prices">
          <p>The prices are for the team of {companyName}. Sign in first.</p>
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
    case 'hidden':
      return (
        <FocusedPanel title="Prices are not available">
          <p>Prices are not open for {companyName} yet.</p>
          {signInLink}
        </FocusedPanel>
      );
    case 'not-secured':
      return <WorkNotSecured retry={phase.retry} />;
    case 'unavailable':
      return (
        <FocusedPanel title="We could not open the prices">
          <p>Check your connection, then try again.</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
          {signInLink}
        </FocusedPanel>
      );
    case 'owner':
      return (
        <PricesFrame companyName={companyName}>
          <PricesEditor
            user={phase.user}
            initialWorking={phase.prices.workingCopy}
            initialCurrent={phase.prices.current}
            onSignInAgain={async (from) => {
              const auth = authRef.current;
              const toSignIn = () => router.push(`/sign-in/${address}`);
              return auth ? signOutOrShow(() => signOutOnRefusal(auth, tenantId, config, 'sign-in-again', false, from), setPhase, toSignIn) : toSignIn();
            }}
          />
        </PricesFrame>
      );
    case 'reader': {
      const current = phase.prices.current;
      return (
        <PricesFrame companyName={companyName}>
          {current ? (
            <>
              <p role="status">
                Version {current.sequence}, published {new Date(current.publishedAt).toLocaleDateString()}. Only the owner can
                change the prices.
              </p>
              <ReadOnlyItems table={current.table} />
              <RoomPays table={current.table} />
            </>
          ) : (
            <p role="status">The owner has not published any prices yet, so estimates cannot be priced.</p>
          )}
          {signInLink}
        </PricesFrame>
      );
    }
  }
}

// The frame of a ready Prices page: a wider column than the sign-in panels, for the long list.
function PricesFrame({ companyName, children }: { companyName: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <p className="text-sm font-semibold tracking-wide">DryScope · {companyName}</p>
      <h1 className="text-2xl font-semibold leading-tight">Prices</h1>
      {children}
    </main>
  );
}
