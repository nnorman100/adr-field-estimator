import { disableNetwork, enableNetwork } from 'firebase/firestore';
import { getIdTokenResult } from 'firebase/auth';
import { callApi } from '@/lib/firebase-client';
import { appCheckSeam, discardFieldWork, fieldUser, settle, type FieldClient } from '@/lib/field-db';
import { saveMe, type DsMe } from './ds-me';
import { SyncGate, type GateState, type MeFacts } from './sync-gate';
import { noteLocked, noteUnlocked } from './unsent';

// Runs the sync gate for one person's started field client (S6-3), and does what each of its
// answers asks of the phone:
// - open: the server let this person in, so any earlier lock is cleared, the unsent mark is
//   cleared once the queue has been sent, and the ds-me row gets the company id, role,
//   capabilities and sign-in time for the next offline start;
// - locked as a disabled member or an inactive company: the work stays, locked, and is removed
//   only after 30 days of refusals (owner decision O5).

export const LOCKED_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

export type SyncEvent = { state: GateState } | { removed: true };

export function runFieldSync(
  client: FieldClient,
  saved: DsMe,
  onEvent: (event: SyncEvent) => void,
  now: () => number = Date.now,
): SyncGate {
  const { person } = client;
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
    onState(state) {
      onEvent({ state });
      if (state.kind === 'open') {
        noteUnlocked(person.tenantId, person.uid);
        void settle(client).catch(() => undefined);
        void remember(saved, state.facts);
      }
      if (state.kind === 'locked' && (state.reason === 'member-disabled' || state.reason === 'company-inactive')) {
        const since = noteLocked(person.tenantId, person.uid, now());
        if (now() - since > LOCKED_LIMIT_MS) {
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
    let authTime = row.authTime;
    try {
      if (user) authTime = Date.parse((await getIdTokenResult(user)).authTime);
    } catch {
      // Keeps the time saved before.
    }
    const { savedAt: _savedAt, ...rest } = row;
    void _savedAt;
    await saveMe({
      ...rest,
      companyName: facts.companyName,
      companyId: facts.companyId,
      role: facts.role,
      capabilities: facts.capabilities,
      ...(Number.isFinite(authTime) ? { authTime } : {}),
    });
  }

  gate.start();
  return gate;
}
