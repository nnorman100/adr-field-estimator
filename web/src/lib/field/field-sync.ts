import { disableNetwork, enableNetwork } from 'firebase/firestore';
import { getIdTokenResult } from 'firebase/auth';
import { callApi } from '@/lib/firebase-client';
import { appCheckSeam, discardFieldWork, fieldUser, settle, type FieldClient } from '@/lib/field-db';
import { forgetMe, updateMe, type DsMe } from './ds-me';
import { SyncGate, type GateState, type MeFacts } from './sync-gate';
import { noteLocked, noteUnlocked, savedLock } from './unsent';

// Runs the sync gate for one person's started field client (S6-3), and does what each of its
// answers asks of the phone:
// - open: the server let this person in, so any earlier lock is cleared, the unsent mark is
//   cleared once the queue has been sent, and the ds-me row gets the company id, role,
//   capabilities and sign-in time for the next offline start;
// - locked: the work stays, locked, and the refusal is saved on the phone, so a start with no answer
//   is locked too; a phone that cannot save it forgets the offline sign-in instead. A disabled
//   member's or inactive company's work is removed only after 30 days of refusals (owner decision O5).
// An answer for a sign-in that has changed while it was awaited is dropped (sync-gate.ts).

export const LOCKED_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

// `me`: the row saved for the next offline start after an online check let the person in.
export type SyncEvent = { state: GateState } | { removed: true } | { me: DsMe };

export function runFieldSync(
  client: FieldClient,
  saved: DsMe,
  onEvent: (event: SyncEvent) => void,
  now: () => number = Date.now,
): SyncGate {
  const { person } = client;
  const lock = savedLock(person.tenantId, person.uid);
  const initial = lock === null ? undefined : ({ kind: 'locked', reason: lock } as const);
  const gate: SyncGate = new SyncGate({
    async ask() {
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
    onState(state) {
      onEvent({ state });
      if (state.kind === 'open') {
        noteUnlocked(person.tenantId, person.uid);
        void settle(client).catch(() => undefined);
        void remember(saved, state.facts);
      }
      if (state.kind === 'locked') {
        const since = noteLocked(person.tenantId, person.uid, state.reason, now());
        if (since === null) {
          void forgetMe(person.tenantId, person.uid);
          return;
        }
        if ((state.reason === 'member-disabled' || state.reason === 'company-inactive') && now() - since > LOCKED_LIMIT_MS) {
          gate.stop();
          void discardFieldWork(person, { lockHeld: true }).then((result) => {
            if (result === 'discarded') onEvent({ removed: true });
          });
        }
      }
    },
  });

  async function remember(row: DsMe, facts: MeFacts): Promise<void> {
    const user = fieldUser(person);
    if (!user) return;
    let authTime = row.authTime;
    try {
      authTime = Date.parse((await getIdTokenResult(user)).authTime);
    } catch {
      // Keeps the time saved before.
    }
    if (fieldUser(person) !== user) return;
    const { savedAt: _savedAt, ...rest } = row;
    void _savedAt;
    const next = {
      ...rest,
      companyName: facts.companyName,
      companyId: facts.companyId,
      role: facts.role,
      capabilities: facts.capabilities,
      ...(Number.isFinite(authTime) ? { authTime } : {}),
    };
    if (await updateMe(next)) onEvent({ me: { ...next, savedAt: now() } });
  }

  if (initial) onEvent({ state: initial });
  gate.start();
  return gate;
}
