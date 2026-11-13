'use client';

import { onAuthStateChanged } from 'firebase/auth';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { companyAuth } from '@/lib/firebase-client';
import { mirrorSignIn, startFieldClient, type CacheKind, type FieldClient } from '@/lib/field-db';
import type { DsMe } from '@/lib/field/ds-me';
import { runFieldSync } from '@/lib/field/field-sync';
import { askToPersist, keepAnswer, saveKeepAnswer, type KeepAnswer } from '@/lib/field/keep-consent';
import type { FieldSurface } from '@/lib/field/platform';
import { offlineSignInValid, type GateState, type SyncGate } from '@/lib/field/sync-gate';
import { unsentWork } from '@/lib/field/unsent';
import { holdWindow } from '@/lib/field/window-lock';
import * as text from './field-store-text';

// The phone's side of the field database in the shell (S6-3): asks once per phone and company
// whether to keep jobs here, takes the one-window lock, starts this person's Firestore client
// (src/lib/field-db.ts) and runs the sync gate (src/lib/field/sync-gate.ts), and says plainly
// what the phone is waiting for. The job screens (S5a-6) mount as its children and use the client
// from FieldContext; nothing here renders on the server.

// What the started cache keeps: the jobs on this phone, nothing by choice (online only), or
// nothing because the phone's storage failed (the memory fallback).
export type FieldStorage = 'kept' | 'online-only' | 'not-saved';

export type FieldMe = { companyId: string | null; role: string | null; capabilities: string[] };
export type FieldContextValue = { client: FieldClient; me: FieldMe; gate: GateState };
const FieldContext = createContext<FieldContextValue | null>(null);

// The started client and who the person is (from the server when online, from ds-me offline).
export function useFieldClient(): FieldContextValue | null {
  return useContext(FieldContext);
}

type Phase =
  | { kind: 'starting' }
  | { kind: 'one-window' }
  // No window lock to be had (no Web Locks, or the request refused): no field client at all.
  | { kind: 'no-lock' }
  | { kind: 'reopen' }
  | { kind: 'ready'; client: FieldClient }
  | { kind: 'removed' };

function Notice({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-input p-4" aria-labelledby={title ? 'field-notice' : undefined}>
      {title ? (
        <h2 id="field-notice" className="text-xl font-semibold">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

function KeepQuestion({ onAnswer }: { onAnswer: (answer: KeepAnswer) => void }) {
  return (
    <Notice title={text.KEEP_TITLE}>
      <p className="text-base">{text.KEEP_WHAT}</p>
      <p className="text-base">{text.KEEP_LIMITS}</p>
      <Button onClick={() => onAnswer('keep')}>{text.KEEP_YES}</Button>
      <Button variant="outline" onClick={() => onAnswer('online-only')}>
        {text.KEEP_NO}
      </Button>
    </Notice>
  );
}

function gateLine(gate: GateState, address: string): ReactNode {
  switch (gate.kind) {
    case 'renewing':
      return <p className="text-base">{text.RENEWING_TEXT}</p>;
    case 'checking-phone':
      return <p className="text-base">{text.CHECKING_PHONE_TEXT}</p>;
    case 'locked':
      if (gate.reason === 'member-disabled') return <p className="text-base">{text.LOCKED_DISABLED_TEXT}</p>;
      if (gate.reason === 'company-inactive') return <p className="text-base">{text.LOCKED_INACTIVE_TEXT}</p>;
      return (
        <>
          <p className="text-base">{text.LOCKED_SIGN_IN_TEXT}</p>
          <a className="inline-flex min-h-11 items-center text-base font-medium underline" href={`/sign-in/${address}`}>
            Go to sign in
          </a>
        </>
      );
    default:
      return null;
  }
}

export function FieldStore({
  me,
  surface,
  reachable,
  onStorage,
  children,
}: {
  me: DsMe;
  surface: FieldSurface | null;
  reachable: boolean;
  onStorage: (storage: FieldStorage) => void;
  children?: ReactNode;
}) {
  const [answer, setAnswer] = useState<KeepAnswer | null>(() => keepAnswer(me.tenantId));
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [gate, setGate] = useState<GateState>({ kind: 'starting' });
  // The latest sign-in facts saved for the offline start: the row this shell started from, then
  // each row saved after an online check let the person in.
  const [known, setKnown] = useState<DsMe>(me);
  // The time the saved sign-in's age is judged at: each gate decision, and every minute.
  const [now, setNow] = useState(() => Date.now());
  const gateRef = useRef<SyncGate | null>(null);
  const hasDatabase = Boolean(me.config.firestoreDatabaseId);
  // An iPhone browser tab keeps nothing for later (G8, D-025): online only, nothing to ask.
  const cache: CacheKind | null =
    surface === null ? null : surface === 'ios-tab' || answer === 'online-only' ? 'memory' : answer === 'keep' ? 'persistent' : null;

  useEffect(() => {
    if (!hasDatabase || cache === null) return;
    let live = true;
    let release = () => undefined as void;
    const person = { tenantId: me.tenantId, uid: me.uid, config: me.config };
    void (async () => {
      const lock = await holdWindow();
      if (!live) return lock.result === 'held' ? lock.release() : undefined;
      if (lock.result !== 'held') {
        if (lock.result === 'elsewhere') return setPhase({ kind: 'one-window' });
        onStorage('not-saved');
        return setPhase({ kind: 'no-lock' });
      }
      release = lock.release;
      await mirrorSignIn(person).catch(() => false);
      const started = await startFieldClient(person, cache);
      if (!live) return;
      if (started.kind === 'no-database') return;
      if (started.kind === 'reopen') return setPhase({ kind: 'reopen' });
      onStorage(started.client.cache === 'persistent' ? 'kept' : started.fellBack ? 'not-saved' : 'online-only');
      if (cache === 'persistent') void askToPersist();
      setPhase({ kind: 'ready', client: started.client });
      gateRef.current = runFieldSync(started.client, me, (event) => {
        if (!live) return;
        if ('removed' in event) return setPhase({ kind: 'removed' });
        if ('me' in event) return setKnown(event.me);
        setGate(event.state);
        setNow(Date.now());
      });
    })();
    // A sign-out or a new sign-in in this company's Auth while the shell is open: the person app
    // follows it, and the gate asks again.
    const stopAuth = onAuthStateChanged(companyAuth({ config: me.config, tenantId: me.tenantId }), () => {
      void mirrorSignIn(person).then(() => gateRef.current?.poke(), () => undefined);
    });
    const poke = () => {
      if (document.visibilityState === 'visible') gateRef.current?.poke();
    };
    document.addEventListener('visibilitychange', poke);
    return () => {
      live = false;
      stopAuth();
      document.removeEventListener('visibilitychange', poke);
      gateRef.current?.stop();
      gateRef.current = null;
      release();
    };
    // `me` is the saved sign-in this shell started from; a new one remounts the shell's content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDatabase, cache, me.tenantId, me.uid]);

  useEffect(() => {
    const current = gateRef.current;
    if (!current) return;
    if (reachable) current.poke();
    else void current.networkLost();
  }, [reachable]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);

  // Edits in a memory cache are gone when the window closes: leaving with any unsent asks first.
  const inMemory = phase.kind === 'ready' && phase.client.cache === 'memory';
  useEffect(() => {
    if (!inMemory) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (unsentWork(me.tenantId, me.uid) === 'none') return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [inMemory, me.tenantId, me.uid]);

  if (!hasDatabase) return <>{children}</>;
  if (surface !== 'ios-tab' && answer === null) {
    return (
      <KeepQuestion
        onAnswer={(chosen) => {
          saveKeepAnswer(me.tenantId, chosen);
          if (chosen === 'keep') void askToPersist();
          setAnswer(chosen);
        }}
      />
    );
  }
  if (phase.kind === 'one-window') {
    return (
      <Notice title={text.ONE_WINDOW_TITLE}>
        <p className="text-base">{text.ONE_WINDOW_TEXT}</p>
      </Notice>
    );
  }
  if (phase.kind === 'no-lock') {
    return (
      <Notice title={text.NO_LOCK_TITLE}>
        <p className="text-base">{text.NO_LOCK_TEXT}</p>
      </Notice>
    );
  }
  if (phase.kind === 'reopen') {
    return (
      <Notice title={text.REOPEN_TITLE}>
        <p className="text-base">{text.REOPEN_TEXT}</p>
      </Notice>
    );
  }
  if (phase.kind === 'removed') {
    return (
      <Notice>
        <p className="text-base">{text.REMOVED_TEXT}</p>
      </Notice>
    );
  }
  if (phase.kind === 'starting') return <p role="status">Opening your jobs…</p>;

  // With no answer from the server (yet), the saved sign-in stands in only within the role's limit.
  if ((gate.kind === 'offline' || gate.kind === 'starting') && !offlineSignInValid(known, now)) {
    return (
      <Notice title={text.ONLINE_ONCE_TITLE}>
        <p className="text-base">{text.ONLINE_ONCE_TEXT}</p>
      </Notice>
    );
  }
  const fieldMe: FieldMe =
    gate.kind === 'open'
      ? { companyId: gate.facts.companyId, role: gate.facts.role, capabilities: gate.facts.capabilities }
      : { companyId: known.companyId ?? null, role: known.role ?? null, capabilities: known.capabilities ?? [] };
  return (
    <FieldContext.Provider value={{ client: phase.client, me: fieldMe, gate }}>
      <div role="status" className="flex flex-col gap-2">
        {gateLine(gate, me.address)}
      </div>
      {answer === 'online-only' && surface !== 'ios-tab' ? <p className="text-base">{text.ONLINE_ONLY_NOTICE}</p> : null}
      {/* Locked work is neither sent nor added to. */}
      {gate.kind === 'locked' ? null : children}
    </FieldContext.Provider>
  );
}
