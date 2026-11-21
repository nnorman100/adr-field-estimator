import { disableNetwork, enableNetwork } from 'firebase/firestore';
import { getIdTokenResult } from 'firebase/auth';
import { callApi } from '@/lib/firebase-client';
import { appCheckSeam, fieldUser, settle, type FieldClient } from '@/lib/field-db';
import { meKey, readMe, updateMe, type DsMe } from './ds-me';
import { noteItemListAccess } from './ds-prices';
import { meActor, sessionValid, SyncGate, type GateState, type MeAnswer, type MeFacts } from './sync-gate';
import { evaluate, onWorkRemoved, pendingReason, type RetentionEvent } from './retention';
import { onJournalLost, reconcileJournal } from './journal-sync';
import { savedLock, savedReason } from './unsent';

// Runs the sync gate for one person's started field client (S6-3), and does what each of its
// answers asks of the phone:
// - open: the unsent mark is cleared once the queue has been sent, and the ds-me row gets the
//   company id, role, capabilities, actor id and sign-in time for the next offline start;
// - a refusal: the work stays, locked, so a start with no answer is locked too.
// Whether the work is locked, and whether it may still be sent at all, is not decided here: every
// decision of the gate is told to the phone's one retention routine (retention.ts, S6-3b), which
// answers with the person's state.
// - A refusal, and a saved sign-in found past its role's limit, are told before anything else is
//   judged, so the 30-day clock (O5) starts whatever the sign-in's age and whether or not the server
//   answered. A phone that cannot save it keeps everything as it is, the gate stays shut, and it
//   asks again.
// - The server letting the person in lifts their lock, however old (decision 010). A phone that
//   cannot save the lifting keeps the lock shown, the network off, and asks again.
// - Work locked past the limit is hidden, and the gate keeps asking whenever there is signal: the
//   server refusing the person then removes it (only a refusal the server gave, never the gate's
//   own "no sign-in to ask with"), and the server letting them in shows it again.
// - When that routine removes this person's work, the gate stops and the shell is told ('removed');
//   when it stopped this client to remove the work and could not finish, the gate stops and the
//   shell asks for the app to be opened again ('reopen').
// The gate starts paused when the page is hidden by the time the client has started; showing the
// page resumes it (field-store.tsx).
// The gate judges the person's ds-me row (read again before each check) against the role's session
// limit, the same check the shell makes before it shows anything. An answer for a sign-in that has
// changed while it was awaited is dropped (sync-gate.ts).

// `me`: the row saved for the next offline start after an online check let the person in.
export type SyncEvent = { state: GateState } | { removed: true } | { reopen: true } | { me: DsMe };

export function runFieldSync(
  client: FieldClient,
  saved: DsMe,
  onEvent: (event: SyncEvent) => void,
  now: () => number = Date.now,
): SyncGate {
  const { person } = client;
  let row = saved;
  const tell = (event: RetentionEvent) => evaluate(now(), event).state;
  const refuse = (reason: Extract<RetentionEvent, { kind: 'refused' }>['reason'], fromServer = false) =>
    tell({ kind: 'refused', person, reason, fromServer });
  // The answers GET /api/me gave; not the one ask() makes up when there is no sign-in to ask with.
  const fromServer = new WeakSet<MeAnswer>();
  // The person's id in the company (`actor.id`) from the last answer the server gave: the job screens
  // tell their own jobs from other people's by it, so it goes out with the facts of an open gate.
  let actorId: string | undefined;
  // The saved sign-in is judged first: one that counts again lifts a lock only its age had made.
  tell({ kind: 'entry', person, saved });
  // A refusal this page holds and could not save yet locks as a saved one does.
  const lock = savedReason(person.tenantId, person.uid) ?? pendingReason(person.tenantId, person.uid);
  // A sign-in past its limit shows as "sign in again".
  const initial = lock === null ? undefined : ({ kind: 'locked', reason: lock === 'sign-in-expired' ? 'sign-in-again' : lock } as const);
  const stopWatching = onWorkRemoved((whose, removed) => {
    if (whose !== meKey(person.tenantId, person.uid)) return;
    gate.stop();
    onEvent(removed ? { removed: true } : { reopen: true });
  });
  // The recovery journal's storage lost its connection twice (S6-4): the shell asks for the app to be
  // opened again, as for a cache that could not be cleared.
  const stopLost = onJournalLost(client, () => {
    gate.stop();
    onEvent({ reopen: true });
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
      const answer = await callApi(user, '/api/me');
      fromServer.add(answer);
      if (answer.status === 200) actorId = meActor(answer.body).actorId ?? actorId;
      return answer;
    },
    enableNetwork: () => enableNetwork(client.db),
    disableNetwork: () => disableNetwork(client.db),
    appCheck: appCheckSeam(),
    now,
    onAnswer: (answer) => {
      if (fromServer.has(answer)) noteItemListAccess(person, answer);
    },
    initial,
    session: () => fieldUser(person),
    sessionValid: (at) => sessionValid(row, at),
    onRefused: (reason, answer) => refuse(reason, fromServer.has(answer)) !== 'unsaved',
    onExpired: () => refuse('sign-in-expired') !== 'unsaved',
    // Asked after every answer, a missing one included, so a refusal the phone could not save is
    // tried again then too.
    mayOpen: (opening) => {
      if (!opening) {
        tell({ kind: 'entry', person, saved: row });
        return true;
      }
      if (tell({ kind: 'let-in', person }) !== 'unsaved') return true;
      return { kind: 'locked', reason: savedLock(person.tenantId, person.uid) ?? 'sign-in-again' };
    },
    onStopped: () => {
      stopWatching();
      stopLost();
    },
    startSuspended: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onState: apply,
  });

  function apply(state: GateState): void {
    const shown: GateState = state.kind === 'open' && actorId ? { ...state, facts: { ...state.facts, actorId } } : state;
    onEvent({ state: shown });
    if (shown.kind === 'open') {
      void settle(client).catch(() => undefined);
      // What became of the edits an earlier page left in the recovery journal (S6-4).
      void reconcileJournal(client);
      void remember(row, shown.facts);
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
      ...(facts.actorId ? { actorId: facts.actorId } : {}),
      ...(Number.isFinite(authTime) ? { authTime } : {}),
    };
    if (await updateMe(next)) {
      row = (await readMe(person.tenantId, person.uid)) || row;
      onEvent({ me: row });
    }
  }

  // A lock saved by an earlier refusal goes through the same handling as a new one; then the server
  // is asked, which alone may remove work past the limit or show it again.
  if (initial) apply(initial);
  if (lock) refuse(lock);
  gate.start();
  return gate;
}
