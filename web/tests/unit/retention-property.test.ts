import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldPerson } from '@/lib/field-db';
import type { LockReason, SavedReason } from '@/lib/field/unsent';

// S6-3b: random sequences of refusals, sign-outs, sign-ins, days passing, the phone opening in two
// tabs, storage that refuses and another window holding the work, run through the phone's one
// retention routine (src/lib/field/retention.ts), and checked after every step against the owner's
// two rules (decisions 010, 011):
//   - after 30 days locked, the next entry point shows none of that person's work offline (it is
//     hidden, read from the lock and the clock alone);
//   - work is never removed without a fresh refusal from the server, in that operation, saying the
//     person or the company is refused or removed.
// The phone they run on is retention-phone.ts; the examples are in retention-machine.test.ts.

const helper = await vi.hoisted(async () => import('./retention-phone'));
vi.mock('@/lib/field/ds-me', async (original) => helper.dsMe(await original<typeof import('@/lib/field/ds-me')>()));
vi.mock('@/lib/firebase-client', () => ({ signOutCompany: async () => undefined }));
vi.mock('@/lib/field/window-lock', () => ({ holdsWindow: () => helper.phone.ownsWindow }));
vi.mock('@/lib/field-db', () => helper.fieldDb());

const { DAY, START, config, keyOf, phone, storage, ana, ben, otherAna, saveRow, lockOf, authFor } = helper;
const { evaluate, forgetPending, onWorkRemoved } = await import('@/lib/field/retention');
const { signOutKeeping, signOutOnRefusal, WorkNotSecuredError } = await import('@/lib/field/sign-out');
// A second tab: its own copy of the routine's modules, over the same storage and saved sign-ins.
vi.resetModules();
const secondTab = { ...(await import('@/lib/field/retention')), ...(await import('@/lib/field/sign-out')) };
const firstTab = { evaluate, forgetPending, onWorkRemoved, signOutKeeping, signOutOnRefusal, WorkNotSecuredError };
const TABS = [firstTab, secondTab];
const { sessionValid } = await import('@/lib/field/sync-gate');
const { RETAINED_REASONS, lockOutlived, noteWrite } = await import('@/lib/field/unsent');
// O5: 30 days, said here and not read from the code under test.
const LOCKED_LIMIT_MS = 30 * DAY;

let clock = START;
const setClock = (now: number) => {
  clock = now;
  vi.setSystemTime(now);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setClock(START);
  vi.stubGlobal('window', { localStorage: storage });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The model: what the owner's rules say each person's lock, saved sign-in and work must be, written
// from the rules (docs/plans/S6.md, O5 and decisions 010, 011) and not from the code under test. Two
// tabs share the phone's storage and saved sign-ins; each holds, in its own memory, the refusals it
// could not save, with when each was given.
// `admitted`: the server let them in, and the lock was lifted, since they were last locked out.
type Held = { reason: SavedReason; at: number };
type Model = {
  lock: { since: number; reason: SavedReason } | null;
  row: { role: string; authTime: number } | null;
  work: boolean;
  admitted: boolean;
  pending: [Held[], Held[]];
};
// What the server says when the person or the company is refused or removed (decision 011).
const REMOVING: SavedReason[] = ['company-inactive', 'member-disabled', 'needs-invitation', 'account-disabled'];
const PEOPLE = [ana, ben, otherAna];
const REASONS: LockReason[] = [
  'verify-email',
  'needs-invitation',
  'member-disabled',
  'company-inactive',
  'second-step',
  'sign-in-again',
  'not-this-company',
  'account-disabled',
  'session-revoked',
];

type Tab = 0 | 1;
type Command =
  | { kind: 'hours'; hours: number }
  | { kind: 'entry'; tab: Tab }
  // A suspended tab shown again (visibilitychange, pageshow): the routine runs for the page's company.
  | { kind: 'resume'; tab: Tab }
  | { kind: 'write'; who: number }
  // The sync gate: the server's refusal (GET /api/me), the gate's own "no sign-in to ask with", a
  // saved sign-in found past its role's limit, any other check, and the server letting them in.
  | { kind: 'gate-refused'; who: number; tab: Tab; reason: LockReason }
  | { kind: 'gate-signed-out'; who: number; tab: Tab }
  | { kind: 'gate-expired'; who: number; tab: Tab }
  | { kind: 'gate-check'; who: number; tab: Tab }
  | { kind: 'gate-open'; who: number; tab: Tab }
  // A screen ends the sign-in: on the server's refusal, or on one the phone made itself.
  | { kind: 'forced-sign-out'; who: number; tab: Tab; reason: LockReason; fromServer: boolean }
  | { kind: 'own-sign-out'; who: number; tab: Tab }
  | { kind: 'sign-in'; who: number; tab: Tab; role: string }
  | { kind: 'set'; what: 'quota' | 'discardFails' | 'otherWindow' | 'ownsWindow' | 'rowsUnreadable' | 'offline'; on: boolean };

const who = fc.integer({ min: 0, max: PEOPLE.length - 1 });
const tab = fc.constantFrom<Tab>(0, 1);
const reason = fc.constantFrom(...REASONS);
const command: fc.Arbitrary<Command> = fc.oneof(
  // Up to 45 days at a time: the page hidden, the phone in a drawer, or just the next minute.
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('hours' as const), hours: fc.integer({ min: 1, max: 45 * 24 }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('entry' as const), tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('resume' as const), tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('write' as const), who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('gate-refused' as const), who, tab, reason }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('gate-signed-out' as const), who, tab }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('gate-expired' as const), who, tab }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('gate-check' as const), who, tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('gate-open' as const), who, tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('forced-sign-out' as const), who, tab, reason, fromServer: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('own-sign-out' as const), who, tab }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('sign-in' as const), who, tab, role: fc.constantFrom('estimator', 'owner', 'office') }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('set' as const),
      what: fc.constantFrom('quota' as const, 'discardFails' as const, 'otherWindow' as const, 'ownsWindow' as const, 'rowsUnreadable' as const, 'offline' as const),
      on: fc.boolean(),
    }),
  },
);

describe('any sequence of refusals, sign-outs, sign-ins, days, tabs and failing storage', () => {
  it('hides work locked out for more than 30 days at every entry point, and removes work only on a fresh refusal from the server', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { maxLength: 60 }), async (commands) => {
        phone.reset();
        for (const t of TABS) t.forgetPending();
        setClock(START);
        let offline = false;
        const model = new Map<string, Model>(PEOPLE.map((p) => [keyOf(p), { lock: null, row: null, work: false, admitted: false, pending: [[], []] }]));
        const of = (index: number) => ({ p: PEOPLE[index]!, m: model.get(keyOf(PEOPLE[index]!))! });
        const lockedOutTooLong = (m: Model) => m.lock !== null && RETAINED_REASONS.has(m.lock.reason) && clock - m.lock.since > LOCKED_LIMIT_MS;
        const signInCounts = (m: Model) => m.row !== null && sessionValid(m.row, clock);
        const canRemove = () => !phone.discardFails && !(phone.otherWindow && !phone.ownsWindow);

        // The rules.
        // A lock is saved with when its refusal was given; one already saved keeps its time. A
        // refusal that removes work after 30 days is not replaced by a plain "sign in again", and
        // none of them by the sign-in's own age. A write the phone refuses is never saved.
        const lockAt = (m: Model, why: SavedReason, since: number): boolean => {
          if (phone.quota) return false;
          const before = m.lock?.reason;
          const keeps = before !== undefined && RETAINED_REASONS.has(before) && (why === 'sign-in-expired' || (why === 'sign-in-again' && before !== 'sign-in-expired'));
          m.lock = { since: m.lock?.since ?? since, reason: keeps ? before : why };
          m.admitted = false;
          return true;
        };
        // A refusal: a hidden lock is kept as it is; otherwise saved now, unless the tab holds
        // refusals for the person, which go first. One that cannot be saved is held by the tab with
        // its time (the same one again keeps the first time). True when the phone holds the lock.
        const refuse = (m: Model, t: Tab, why: SavedReason): boolean => {
          if (lockedOutTooLong(m) || (m.pending[t].length === 0 && lockAt(m, why, clock))) return true;
          if (m.pending[t].at(-1)?.reason !== why) m.pending[t].push({ reason: why, at: clock });
          return false;
        };
        // At the start of every evaluate the tab saves what it holds, each with its own time.
        const retryHeld = (t: Tab) => {
          for (const m of model.values()) m.pending[t] = m.pending[t].filter((held) => !(lockedOutTooLong(m) || lockAt(m, held.reason, held.at)));
        };
        // The server let the person in: their own lock goes, however old, and so does what the tab
        // holds for them. 'unsaved' when the phone could not lift it (nothing may open then).
        const letIn = (m: Model, t: Tab): 'none' | 'unsaved' => {
          if (m.lock !== null && phone.quota) return 'unsaved';
          m.lock = null;
          m.pending[t] = [];
          return 'none';
        };
        // A saved sign-in, judged: past its role's limit the person is locked out from now (false
        // when that cannot be saved); one that counts lifts a lock that only its age had made,
        // unless it is hidden.
        const judge = (m: Model, t: Tab): boolean => {
          if (m.row === null) return true;
          if (!signInCounts(m)) return refuse(m, t, 'sign-in-expired');
          if (m.lock?.reason === 'sign-in-expired' && !lockedOutTooLong(m) && !phone.quota) m.lock = null;
          return true;
        };
        // Whether this refusal, saved, removes the person's work: the server's own answer, saying the
        // person or the company is refused or removed, while the work is hidden.
        const removes = (m: Model, saved: boolean, fromServer: boolean, why: SavedReason) => saved && fromServer && REMOVING.includes(why) && lockedOutTooLong(m);
        // An evaluate's sweep: every saved sign-in judged (none when they cannot be read), then the
        // removal the event confirmed.
        const sweep = (t: Tab, confirmed: string | null): string[] => {
          if (!phone.rowsUnreadable) for (const m of model.values()) judge(m, t);
          const m = confirmed === null ? null : model.get(confirmed)!;
          if (m === null || !lockedOutTooLong(m) || !canRemove()) return [];
          // Never while their sign-in counts and the server has let them in.
          expect(m.admitted && signInCounts(m)).toBe(false);
          Object.assign(m, { lock: null, work: false });
          return [confirmed!];
        };
        // What the code removed against what the rules say: exactly that, and nobody else's work.
        const expectRemoved = async (expected: string[], run: () => Promise<string[]>) => {
          const workBefore = new Set(phone.work);
          const removed = await run();
          expect([...removed].sort()).toEqual([...expected].sort());
          for (const kept of workBefore) expect(phone.work.has(kept)).toBe(!expected.includes(kept));
        };
        // A sign-out, the refusal first when the app makes it on one, then the saved sign-in judged
        // before it goes; each step runs a sweep, and so does the entry point that follows.
        const signOut = async (p: FieldPerson, m: Model, t: Tab, run: () => Promise<void>, refusal?: { why: LockReason; fromServer: boolean }) => {
          const gone: string[] = [];
          const ok = (() => {
            if (refusal) {
              retryHeld(t);
              const saved = refuse(m, t, refusal.why);
              gone.push(...sweep(t, removes(m, saved, refusal.fromServer, refusal.why) ? keyOf(p) : null));
              if (!saved) return false;
            }
            retryHeld(t);
            const judged = judge(m, t);
            gone.push(...sweep(t, null));
            // Nothing held for the person may be left behind by the saved sign-in.
            return judged && m.pending[t].length === 0;
          })();
          // The row goes before the entry point that follows.
          if (ok) m.row = null;
          retryHeld(t);
          gone.push(...sweep(t, null));
          const removed: string[] = [];
          const stop = TABS[t]!.onWorkRemoved((person, done) => done && removed.push(person));
          await expectRemoved(gone, async () => {
            const outcome = await run().then(
              () => 'signed-out',
              (error: unknown) => (error instanceof TABS[t]!.WorkNotSecuredError ? 'not-secured' : 'failed'),
            );
            await TABS[t]!.evaluate(clock, { kind: 'entry' }).done;
            // The saved sign-in goes only once the phone holds what it must.
            expect(outcome).toBe(ok ? 'signed-out' : 'not-secured');
            expect(phone.rows.has(keyOf(p))).toBe(!ok);
            return removed;
          });
          stop();
        };
        const refusedBy = async (p: FieldPerson, m: Model, t: Tab, why: SavedReason, fromServer: boolean) => {
          retryHeld(t);
          const saved = refuse(m, t, why);
          const result = TABS[t]!.evaluate(clock, { kind: 'refused', person: p, reason: why, fromServer });
          expect(result.state).toBe(!saved ? 'unsaved' : lockedOutTooLong(m) ? 'hidden' : 'locked');
          await expectRemoved(sweep(t, removes(m, saved, fromServer, why) ? keyOf(p) : null), () => result.done);
        };

        for (const step of commands) {
          if (step.kind === 'hours') setClock(clock + step.hours * 60 * 60 * 1000);
          else if (step.kind === 'set') {
            if (step.what === 'offline') offline = step.on;
            else phone[step.what] = step.on;
            // One window holds the lock: this page's field window, or another tab's.
            if (step.on && step.what === 'otherWindow') phone.ownsWindow = false;
            if (step.on && step.what === 'ownsWindow') phone.otherWindow = false;
          } else if (step.kind === 'entry' || step.kind === 'resume') {
            const event = step.kind === 'entry' ? ({ kind: 'entry' } as const) : ({ kind: 'entry', company: { tenantId: 't-a', config } } as const);
            retryHeld(step.tab);
            await expectRemoved(sweep(step.tab, null), () => TABS[step.tab]!.evaluate(clock, event).done);
          } else if (step.kind === 'write') {
            // The shell lets a person work only with a sign-in that counts and no lock, saved or held.
            const { p, m } = of(step.who);
            if (!signInCounts(m) || m.lock !== null || m.pending.some((held) => held.length > 0)) continue;
            if (noteWrite(p.tenantId, p.uid, clock) !== null) {
              phone.work.add(keyOf(p));
              m.work = true;
            }
          } else if (step.kind === 'gate-refused') {
            const { p, m } = of(step.who);
            if (m.row === null || offline) continue;
            await refusedBy(p, m, step.tab, step.reason, true);
          } else if (step.kind === 'gate-signed-out') {
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            await refusedBy(p, m, step.tab, 'sign-in-again', false);
          } else if (step.kind === 'gate-expired') {
            const { p, m } = of(step.who);
            if (m.row === null || signInCounts(m)) continue;
            await refusedBy(p, m, step.tab, 'sign-in-expired', false);
          } else if (step.kind === 'gate-check') {
            // Any other check of the gate: the saved sign-in it runs from is judged, then the sweep.
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            retryHeld(step.tab);
            const judged = judge(m, step.tab);
            const result = TABS[step.tab]!.evaluate(clock, { kind: 'entry', person: p, saved: m.row });
            expect(result.state).toBe(
              !judged ? 'unsaved' : lockedOutTooLong(m) ? 'hidden' : m.lock === null && m.pending[step.tab].length === 0 ? 'none' : 'locked',
            );
            await expectRemoved(sweep(step.tab, null), () => result.done);
          } else if (step.kind === 'gate-open' || step.kind === 'sign-in') {
            // The server lets the person in: from an open shell's gate, or on the sign-in page,
            // where the row is saved first. Nothing opens unless the lock is lifted.
            const { p, m } = of(step.who);
            if (offline) continue;
            if (step.kind === 'sign-in') {
              saveRow(p, step.role, clock);
              m.row = { role: step.role, authTime: clock };
            } else if (!signInCounts(m)) continue;
            retryHeld(step.tab);
            const expected = letIn(m, step.tab);
            const result = TABS[step.tab]!.evaluate(clock, { kind: 'let-in', person: p });
            expect(result.state).toBe(expected);
            if (expected === 'none') m.admitted = true;
            await expectRemoved(sweep(step.tab, null), () => result.done);
          } else if (step.kind === 'forced-sign-out') {
            const { p, m } = of(step.who);
            if (m.row === null || (offline && step.fromServer)) continue;
            const t = step.tab;
            await signOut(p, m, t, () => TABS[t]!.signOutOnRefusal(authFor(p), p.tenantId, config, step.reason, step.fromServer), {
              why: step.reason,
              fromServer: step.fromServer,
            });
          } else {
            // The person's own sign-out (Keep).
            const { p, m } = of(step.who);
            if (m.row === null) continue;
            const t = step.tab;
            await signOut(p, m, t, () => TABS[t]!.signOutKeeping(authFor(p), p.tenantId));
          }

          // After every step the phone holds exactly what the rules say, and work locked out for
          // more than 30 days is hidden: read from the lock and the clock alone.
          for (const p of PEOPLE) {
            const m = model.get(keyOf(p))!;
            expect(lockOf(p), `${keyOf(p)} lock after ${JSON.stringify(step)}`).toEqual(m.lock);
            expect(phone.work.has(keyOf(p)), `${keyOf(p)} work after ${JSON.stringify(step)}`).toBe(m.work);
            expect(phone.rows.has(keyOf(p))).toBe(m.row !== null);
            expect(lockOutlived(p.tenantId, p.uid, clock)).toBe(lockedOutTooLong(m));
          }
        }

        // Whatever happened, once storage answers and no other window holds the work, the server
        // saying each person is turned off removes exactly the work that is hidden, in either tab.
        phone.quota = phone.discardFails = phone.otherWindow = phone.rowsUnreadable = false;
        for (const [index, p] of PEOPLE.entries()) await refusedBy(p, model.get(keyOf(p))!, (index % 2) as Tab, 'member-disabled', true);
        for (const p of PEOPLE) {
          const m = model.get(keyOf(p))!;
          expect(phone.work.has(keyOf(p)) && lockedOutTooLong(m)).toBe(false);
        }
      }),
      {
        numRuns: 400,
        examples: [
          // A refusal on day 0 the phone cannot save; storage answers again; the page comes back on
          // day 31: the refusal is saved with its own time, so the work is hidden, and kept.
          [
            [
              { kind: 'sign-in', who: 0, tab: 0, role: 'estimator' },
              { kind: 'write', who: 0 },
              { kind: 'set', what: 'quota', on: true },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'company-inactive' },
              { kind: 'hours', hours: 31 * 24 },
              { kind: 'set', what: 'quota', on: false },
              { kind: 'entry', tab: 0 },
            ],
          ],
          // An owner past 14 days chooses Keep on a full phone in one tab; 29 days later the owner
          // signs in in another tab, works there and chooses Keep there too; the first tab comes
          // back 2 days later: what it held may hide the work, and nothing removes it.
          [
            [
              { kind: 'sign-in', who: 0, tab: 0, role: 'owner' },
              { kind: 'write', who: 0 },
              { kind: 'hours', hours: 15 * 24 },
              { kind: 'set', what: 'quota', on: true },
              { kind: 'own-sign-out', who: 0, tab: 0 },
              { kind: 'set', what: 'quota', on: false },
              { kind: 'hours', hours: 29 * 24 },
              { kind: 'sign-in', who: 0, tab: 1, role: 'owner' },
              { kind: 'write', who: 0 },
              { kind: 'own-sign-out', who: 0, tab: 1 },
              { kind: 'hours', hours: 2 * 24 },
              { kind: 'resume', tab: 0 },
            ],
          ],
          // Refused on day 0, hidden from day 31 at every entry point and in both tabs; a refusal the
          // phone makes removes nothing, nor does the server's "sign in again"; the server saying the
          // member is turned off does.
          [
            [
              { kind: 'sign-in', who: 0, tab: 0, role: 'estimator' },
              { kind: 'write', who: 0 },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'session-revoked' },
              { kind: 'hours', hours: 31 * 24 },
              { kind: 'entry', tab: 1 },
              { kind: 'gate-signed-out', who: 0, tab: 1 },
              { kind: 'resume', tab: 0 },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'session-revoked' },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'member-disabled' },
            ],
          ],
          // Hidden, then the server lets the person in: their own work shows again.
          [
            [
              { kind: 'sign-in', who: 0, tab: 0, role: 'estimator' },
              { kind: 'write', who: 0 },
              { kind: 'gate-refused', who: 0, tab: 0, reason: 'member-disabled' },
              { kind: 'hours', hours: 31 * 24 },
              { kind: 'sign-in', who: 0, tab: 1, role: 'estimator' },
              { kind: 'entry', tab: 0 },
            ],
          ],
        ],
      },
    );
  });
});
