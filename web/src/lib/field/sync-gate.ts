import { SESSION_RULES } from '@/lib/auth/policy';
import { meOutcome, type MeOutcome } from '@/lib/sign-in/outcome';

// The sync gate (S6-3; docs/plans/S6.md section 3). The field client starts with its network off,
// and this decides when it may go on: only after GET /api/me has answered 200 **and** its
// `fieldAccessExpiresAt` is in the future. A write queued offline for longer than the access record's
// 7 days would otherwise reach Firestore before /api/me renewed the record; the rules would refuse
// it, and the SDK drops a refused write without telling anyone (S6-1 (b)). /api/me renews with a
// call that can be skipped (a busy actor, a row in back-off), so a bare 200 proves nothing: the gate
// waits, asks again after a few seconds, and says "Waiting for access to renew".
//
// Any refusal (member disabled, company inactive, sign in again, second step, ...) leaves the
// network off and the unsent work untouched and locked (owner decisions D7 and O5): the work is
// sent if the same person gets through again, and removed only by an explicit Discard or after 30
// days locked. With no answer at all the phone works offline from `ds-me`.
//
// App Check (TC-7, docs/plans/TC.md): once the access record is current, the gate gets a fresh
// App Check token before the network goes on. In monitor mode a failure or a 5-second wait does not
// hold it; under enforcement it waits ("Checking this phone") and tries again. Either way nothing
// queued is deleted or locked for a token. App Check is not set up yet (TC-5), so the seam is empty
// in the app and filled by the tests.

export type MeAnswer = { status: number; body: unknown };

export type AppCheckSeam = { mode: 'monitor' | 'enforce'; token(): Promise<unknown> };

// What the server said about the person, kept in ds-me for the offline start.
export type MeFacts = { companyId: string; companyName: string; role: string; capabilities: string[]; expiresAt: number };

export type GateState =
  | { kind: 'starting' }
  // No answer: offline, from ds-me. Queued work waits.
  | { kind: 'offline' }
  // Answered 200, but the access record has run out or is not there yet.
  | { kind: 'renewing' }
  // App Check under enforcement, waiting for a token.
  | { kind: 'checking-phone' }
  | { kind: 'open'; facts: MeFacts }
  | { kind: 'locked'; reason: Exclude<MeOutcome['kind'], 'signed-in' | 'unavailable'> };

export type Verdict = { kind: 'open'; facts: MeFacts } | { kind: 'renewing' } | { kind: 'offline' } | Extract<GateState, { kind: 'locked' }>;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// One answer of GET /api/me, judged. `now` is milliseconds since 1970.
export function judgeMe(answer: MeAnswer, now: number): Verdict {
  if (answer.status === 0) return { kind: 'offline' };
  const outcome = meOutcome(answer.status, answer.body);
  if (outcome.kind === 'unavailable') return { kind: 'offline' };
  if (outcome.kind !== 'signed-in') return { kind: 'locked', reason: outcome.kind };
  const companyId = field(field(answer.body, 'company'), 'id');
  const capabilities = field(answer.body, 'capabilities');
  const expires = field(answer.body, 'fieldAccessExpiresAt');
  const expiresAt = typeof expires === 'string' ? Date.parse(expires) : NaN;
  if (typeof companyId !== 'string' || !Array.isArray(capabilities) || !capabilities.every((c) => typeof c === 'string')) {
    return { kind: 'offline' };
  }
  if (!Number.isFinite(expiresAt) || !accessCurrent(expiresAt, now)) return { kind: 'renewing' };
  return {
    kind: 'open',
    facts: { companyId, companyName: outcome.companyName, role: outcome.role, capabilities: capabilities as string[], expiresAt },
  };
}

// The offline `me` read (D7): a sign-in the phone saved stands in for the server while there is no
// signal, but only until the role's own session limit (12 hours to 30 days, S3-8); after that the
// person must open the app once online. A row without a role or sign-in time (written before S6-3)
// does not stand in at all. The rules and the server still decide everything once online.
export function offlineSignInValid(saved: { role?: string; authTime?: number }, now: number): boolean {
  if (typeof saved.role !== 'string' || typeof saved.authTime !== 'number') return false;
  const rule = (SESSION_RULES as Record<string, { maxSignInAgeSeconds: number } | undefined>)[saved.role];
  if (!rule) return false;
  return now - saved.authTime <= rule.maxSignInAgeSeconds * 1000;
}

export const APP_CHECK_MONITOR_WAIT_MS = 5_000;
// The network is on only while the access record the server last confirmed has this much left, so
// no write reaches the rules after the record has run out.
export const EXPIRY_MARGIN_MS = 10_000;
const accessCurrent = (expiresAt: number, now: number): boolean => expiresAt - EXPIRY_MARGIN_MS > now;
const RENEW_FIRST_MS = 3_000;
const RENEW_MAX_MS = 30_000;
const OFFLINE_RETRY_MS = 10_000;
const LOCKED_RETRY_MS = 15_000;
// Ask again a minute before the record runs out, for a window left open that long.
const BEFORE_EXPIRY_MS = 60_000;

export type GateDeps = {
  ask(): Promise<MeAnswer>;
  enableNetwork(): Promise<void>;
  disableNetwork(): Promise<void>;
  appCheck?: AppCheckSeam | null;
  onState(state: GateState): void;
  now?: () => number;
  // The lock saved on the phone by an earlier refusal (O5), kept until the server lets the person in.
  initial?: Extract<GateState, { kind: 'locked' }>;
  // Who an answer is for: an answer is dropped, and asked for again, when this changes while it is
  // awaited.
  session?: () => unknown;
};

// Runs the gate for one field client. Foreground only: it asks on start, on poke() (the app
// became visible, the signal came back, a tap) and on its own timer while the page lives.
export class SyncGate {
  private state: GateState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private again = false;
  private stopped = false;
  private renewWait = RENEW_FIRST_MS;
  private networkOn = false;
  // App Check tokens that would not come in monitor mode, counted on the phone only (no telemetry).
  appCheckMisses = 0;

  constructor(private readonly deps: GateDeps) {
    this.state = deps.initial ?? { kind: 'starting' };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  current(): GateState {
    return this.state;
  }

  start(): void {
    void this.check();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
  }

  // Ask now (an `online` event, the app shown again, a tap).
  poke(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    void this.check();
  }

  // The signal went: the network goes off until /api/me has answered again, so a long gap cannot
  // let queued writes out ahead of a renewal.
  async networkLost(): Promise<void> {
    if (this.stopped) return;
    await this.closeNetwork();
    if (this.state.kind === 'open') this.set({ kind: 'offline' });
  }

  private set(state: GateState): void {
    this.state = state;
    this.deps.onState(state);
  }

  private later(ms: number): void {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => void this.check(), ms);
  }

  private async closeNetwork(): Promise<void> {
    clearTimeout(this.deadline);
    if (!this.networkOn) return;
    this.networkOn = false;
    await this.deps.disableNetwork();
  }

  private closeAt(expiresAt: number): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => void this.expired(), Math.max(expiresAt - EXPIRY_MARGIN_MS - this.now(), 0));
  }

  private async expired(): Promise<void> {
    if (this.stopped) return;
    await this.closeNetwork();
    if (this.state.kind === 'open') this.set({ kind: 'renewing' });
    this.poke();
  }

  // True when the network may go on as far as App Check is concerned.
  private async appCheckPasses(): Promise<boolean> {
    const seam = this.deps.appCheck;
    if (!seam) return true;
    if (seam.mode === 'monitor') {
      const got = await Promise.race([
        seam.token().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((done) => setTimeout(() => done(false), APP_CHECK_MONITOR_WAIT_MS)),
      ]);
      if (!got) this.appCheckMisses += 1;
      return true;
    }
    try {
      await seam.token();
      return true;
    } catch {
      return false;
    }
  }

  private async check(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const session = this.deps.session?.();
      const stale = () => {
        if (this.deps.session?.() === session) return false;
        this.again = true;
        return true;
      };
      let verdict = judgeMe(await this.deps.ask(), this.now());
      if (this.stopped || stale()) return;
      if (verdict.kind === 'open') {
        const passes = await this.appCheckPasses();
        if (this.stopped || stale()) return;
        if (!passes) {
          this.renewWait = RENEW_FIRST_MS;
          this.set({ kind: 'checking-phone' });
          this.later(RENEW_FIRST_MS);
          return;
        }
        if (!accessCurrent(verdict.facts.expiresAt, this.now())) verdict = { kind: 'renewing' };
      }
      if (verdict.kind === 'offline') {
        if (this.state.kind !== 'open' && this.state.kind !== 'locked') this.set({ kind: 'offline' });
        this.later(OFFLINE_RETRY_MS);
        return;
      }
      if (verdict.kind === 'renewing') {
        await this.closeNetwork();
        this.set({ kind: 'renewing' });
        this.later(this.renewWait);
        this.renewWait = Math.min(this.renewWait * 2, RENEW_MAX_MS);
        return;
      }
      this.renewWait = RENEW_FIRST_MS;
      if (verdict.kind === 'locked') {
        await this.closeNetwork();
        this.set(verdict);
        // A disabled member or an inactive company can be let back in by the owner; the other
        // refusals need the person to sign in again, which starts a new gate.
        if (verdict.reason === 'member-disabled' || verdict.reason === 'company-inactive') this.later(LOCKED_RETRY_MS);
        return;
      }
      if (!this.networkOn) {
        await this.deps.enableNetwork();
        this.networkOn = true;
      }
      this.set({ kind: 'open', facts: verdict.facts });
      this.closeAt(verdict.facts.expiresAt);
      this.later(Math.max(verdict.facts.expiresAt - this.now() - BEFORE_EXPIRY_MS, RENEW_FIRST_MS));
    } finally {
      this.running = false;
      if (this.again && !this.stopped) {
        this.again = false;
        clearTimeout(this.timer);
        void this.check();
      }
    }
  }
}
