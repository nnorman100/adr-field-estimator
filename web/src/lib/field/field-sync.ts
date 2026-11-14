import { disableNetwork, enableNetwork } from 'firebase/firestore';
import { getIdTokenResult } from 'firebase/auth';
import { callApi } from '@/lib/firebase-client';
import { appCheckSeam, fieldUser, settle, type FieldClient } from '@/lib/field-db';
import { meKey, readMe, updateMe, type DsMe } from './ds-me';
import { sessionValid, SyncGate, type GateState, type MeFacts } from './sync-gate';
import { evaluate, onWorkRemoved, type RetentionEvent } from './retention';
import { savedLock, savedReason } from './unsent';

// Runs the sync gate for one person's started field client (S6-3), and does what each of its
// answers asks of the phone:
// - open: the unsent mark is cleared once the queue has been sent, and the ds-me row gets the
//   company id, role, capabilities and sign-in time for the next offline start;
// - a refusal: the work stays, locked, so a start with no answer is locked too.
// Whether the work is locked, and whether it may still be sent at all, is not decided here: every
// decision of the gate is told to the phone's one retention routine (retention.ts, S6-3b), which
// answers with the person's state.
// - A refusal, and a saved sign-in found past its role's limit, are told before anything else is
//   judged, so the 30-day clock (O5) starts whatever the sign-in's age and whether or not the server
//   answered. A phone that cannot save it keeps everything as it is, the gate stays shut, and it
//   asks again.
// - The server letting the person in lifts the lock, unless the work is past the limit: that work is
//   never sent. A phone that cannot save the lifting keeps the lock shown, the network off, and
//   asks again. The gate asks after every answer, whenever the page is shown again and every minute,
//   and stops for good once it is.
// - When that routine removes this person's work, from whichever of the phone's entry points, the
//   gate stops and the shell is told ('removed').
// The gate starts paused when the page is hidden by the time the client has started; showing the
// page resumes it (field-store.tsx).
// The gate judges the person's ds-me row (read again before each check) against the role's session
// limit, the same check the shell makes before it shows anything. An answer for a sign-in that has
// changed while it was awaited is dropped (sync-gate.ts).

// `me`: the row saved for the next offline start after an online check let the person in.
export type SyncEvent = { state: GateState } | { removed: true } | { me: DsMe };

export function runFieldSync(
  client: FieldClient,
  saved: DsMe,
  onEvent: (event: SyncEvent) => void,
  now: () => number = Date.now,
): SyncGate {
  const { person } = client;
  let row = saved;
  const tell = (event: RetentionEvent) => evaluate(now(), event).state;
  // The saved sign-in is judged first: one that counts again lifts a lock only its age had made.
  tell({ kind: 'entry', person, saved });
  const lock = savedReason(person.tenantId, person.uid);
  // A sign-in past its limit shows as "sign in again".
  const initial = lock === null ? undefined : ({ kind: 'locked', reason: lock === 'sign-in-expired' ? 'sign-in-again' : lock } as const);
  const stopWatching = onWorkRemoved((removed) => {
    if (removed !== meKey(person.tenantId, person.uid)) return;
    gate.stop();
    onEvent({ removed: true });
  });
  const gate: SyncGate = new SyncGate({
    async ask() {
      const newer = await readMe(person.tenantId, person.uid);
      if (newer && newer.savedAt !== row.savedAt) {
        row = newer;
        onEvent({ me: row });
      }
      const user = fieldUser(person);
      if (!user) return { status: 401, body: { error: 'missing_token' } };
      return callApi(user, '/api/me');
    },
    enableNetwork: () => enableNetwork(client.db),
    disableNetwork: () => disableNetwork(client.db),
    appCheck: appCheckSeam(),
    now,
    initial,
    session: () => fieldUser(person),
    sessionValid: (at) => sessionValid(row, at),
    onRefused: (reason) => tell({ kind: 'refused', person, reason }) !== 'unsaved',
    onExpired: () => tell({ kind: 'refused', person, reason: 'sign-in-expired' }) !== 'unsaved',
    mayOpen: (opening) => {
      const state = tell(opening ? { kind: 'let-in', person } : { kind: 'entry', person, saved: row });
      if (state !== 'unsaved') return state !== 'expired';
      return { kind: 'locked', reason: savedLock(person.tenantId, person.uid) ?? 'sign-in-again' };
    },
    onStopped: stopWatching,
    startSuspended: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onState: apply,
  });

  function apply(state: GateState): void {
    onEvent({ state });
    if (state.kind === 'open') {
      void settle(client).catch(() => undefined);
      void remember(row, state.facts);
    }
  }

  async function remember(base: DsMe, facts: MeFacts): Promise<void> {
    const user = fieldUser(person);
    if (!user) return;
    let authTime = base.authTime;
    try {
      authTime = Date.parse((await getIdTokenResult(user)).authTime);
    } catch {
      // Keeps the time saved before.
    }
    if (fieldUser(person) !== user) return;
    const { savedAt: _savedAt, ...rest } = base;
    void _savedAt;
    const next = {
      ...rest,
      companyName: facts.companyName,
      companyId: facts.companyId,
      role: facts.role,
      capabilities: facts.capabilities,
      ...(Number.isFinite(authTime) ? { authTime } : {}),
    };
    if (await updateMe(next)) {
      row = (await readMe(person.tenantId, person.uid)) ?? row;
      onEvent({ me: row });
    }
  }

  // A lock saved by an earlier refusal goes through the same handling as a new one. Work already
  // past the limit is not asked about: the routine removes it.
  if (initial) apply(initial);
  if (tell(lock ? { kind: 'refused', person, reason: lock } : { kind: 'entry', person }) !== 'expired') gate.start();
  return gate;
}
