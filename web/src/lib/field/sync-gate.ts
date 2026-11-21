import { SESSION_RULES } from '@/lib/auth/policy';
import { aiSummaryEnabled, readinessEnabled } from '@/lib/readiness/feature';
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
// days locked. Disabling a member also signs them out everywhere, so a phone's old sign-in stays
// refused after the owner turns them back on: the person signs in again, and the work is sent then.
// With no answer at all the phone works offline from `ds-me`.
//
// No wait here is open-ended (S6-3b): /api/me and the App Check token each get a time limit, an
// answer that does not come is asked for again on the usual retry, and a poke (the signal back, the
// page shown again, a new sign-in) calls off whatever the current check is waiting for and asks
// afresh at once, so a stalled request can never hold the gate shut.
//
// App Check (TC-7, docs/plans/TC.md): once the access record is current, the gate gets a fresh
// App Check token before the network goes on. In monitor mode a failure or a 5-second wait does not
// hold it; under enforcement it waits ("Checking this phone") and tries again. Either way nothing
// queued is deleted or locked for a token. App Check is not set up yet (TC-5), so the seam is empty
// in the app and filled by the tests.

export type MeAnswer = { status: number; body: unknown };

export type AppCheckSeam = { mode: 'monitor' | 'enforce'; token(): Promise<unknown> };

// What /api/me said about the person. The live readiness flag is used only by screens.
export type MeFacts = {
  companyId: string;
  companyName: string;
  role: string;
  capabilities: string[];
  actorId?: string;
  expiresAt: number;
  readiness?: true;
  // The company's AI summary draft switch (S7-6), live only, like readiness.
  aiSummary?: true;
};

export type GateState =
  | { kind: 'starting' }
  // No answer: offline, from ds-me. Queued work waits.
  | { kind: 'offline' }
  // Answered 200, but the access record has run out or is not there yet.
  | { kind: 'renewing' }
  // App Check under enforcement, waiting for a token.
  | { kind: 'checking-phone' }
  | { kind: 'open'; facts: MeFacts }
  // The saved sign-in is older than the role's session limit: nothing shows and nothing is sent
  // until the person signs in again.
  | { kind: 'expired' }
  // 'session-revoked': the server refused a sign-in that was revoked (disabling a member does that).
  | { kind: 'locked'; reason: Exclude<MeOutcome['kind'], 'signed-in' | 'unavailable'> | 'session-revoked' };

export type Verdict = { kind: 'open'; facts: MeFacts } | { kind: 'renewing' } | { kind: 'offline' } | Extract<GateState, { kind: 'locked' }>;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// The company id and capabilities of a 200 from GET /api/me, or null when it has another shape.
export function meFacts(body: unknown): { companyId: string; capabilities: string[] } | null {
  const companyId = field(field(body, 'company'), 'id');
  const capabilities = field(body, 'capabilities');
  if (typeof companyId !== 'string' || !Array.isArray(capabilities) || !capabilities.every((c) => typeof c === 'string')) {
    return null;
  }
  return { companyId, capabilities: capabilities as string[] };
}

// The person's id in the company (`actor.id`) of a 200 from GET /api/me, as the field row keeps it;
// nothing when the answer has none.
export function meActor(body: unknown): { actorId: string } | Record<string, never> {
  const actorId = field(field(body, 'actor'), 'id');
  return typeof actorId === 'string' && actorId ? { actorId } : {};
}

// One answer of GET /api/me, judged. `now` is milliseconds since 1970.
export function judgeMe(answer: MeAnswer, now: number): Verdict {
  if (answer.status === 0) return { kind: 'offline' };
  const outcome = meOutcome(answer.status, answer.body);
  if (outcome.kind === 'unavailable') return { kind: 'offline' };
  if (outcome.kind !== 'signed-in') {
    const revoked = answer.status === 401 && field(answer.body, 'error') === 'sign_in_revoked';
    return { kind: 'locked', reason: revoked ? 'session-revoked' : outcome.kind };
  }
  const facts = meFacts(answer.body);
  const expires = field(answer.body, 'fieldAccessExpiresAt');
  const expiresAt = typeof expires === 'string' ? Date.parse(expires) : NaN;
  if (!facts) return { kind: 'offline' };
  if (!Number.isFinite(expiresAt) || !accessCurrent(expiresAt, now)) return { kind: 'renewing' };
  return {
    kind: 'open',
    facts: { ...facts, companyName: outcome.companyName, role: outcome.role, expiresAt, ...(readinessEnabled(answer.body) ? { readiness: true } : {}), ...(aiSummaryEnabled(answer.body) ? { aiSummary: true } : {}) },
  };
}

// The offline `me` read (D7): a sign-in the phone saved stands in for the server while there is no
// signal, but only until the role's own session limit (12 hours to 30 days, S3-8); after that the
// person must open the app once online. A row without a role or sign-in time (written before S6-3)
// does not stand in at all. The rules and the server still decide everything once online.
export function sessionValid(saved: { role?: string; authTime?: number }, now: number): boolean {
  if (typeof saved.role !== 'string' || typeof saved.authTime !== 'number') return false;
  const rule = (SESSION_RULES as Record<string, { maxSignInAgeSeconds: number } | undefined>)[saved.role];
  if (!rule) return false;
  return now - saved.authTime <= rule.maxSignInAgeSeconds * 1000;
}

export const APP_CHECK_MONITOR_WAIT_MS = 5_000;
// The longest the gate waits for GET /api/me, and for an App Check token under enforcement; a late
// answer is not acted on, and the next check asks again.
export const ASK_WITHIN_MS = 15_000;
export const APP_CHECK_ENFORCE_WITHIN_MS = 10_000;
// With no answer, the gate asks again after this (a poke asks at once).
export const OFFLINE_RETRY_MS = 10_000;
const NO_ANSWER: MeAnswer = { status: 0, body: null };
// What a wait answers once a poke, the signal going, the page hidden or a stop has called it off.
const CALLED_OFF = Symbol('called off');
// The network is on only while the access record the server last confirmed has this much left, so
// no write reaches the rules after the record has run out.
export const EXPIRY_MARGIN_MS = 10_000;
const accessCurrent = (expiresAt: number, now: number): boolean => expiresAt - EXPIRY_MARGIN_MS > now;
// Waits for a renewal (doubling from the first) and for an App Check token under enforcement.
const RENEW_FIRST_MS = 3_000;
const RENEW_MAX_MS = 30_000;
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
  // The page is hidden as the gate starts: it asks nothing and the network stays off until resume().
  startSuspended?: boolean;
  // Who an answer is for: an answer is dropped, and asked for again, when this changes while it is
  // awaited.
  session?: () => unknown;
  // Whether the saved sign-in is still within the role's session limit (sessionValid on the
  // person's ds-me row). Asked after every answer, before the network goes on, and by
  // checkSession(); when it is not, the gate is 'expired'.
  sessionValid?: (now: number) => boolean;
  // The three things the gate tells the phone's refusal bookkeeping (O5; retention.ts), so that it
  // never depends on the sign-in still counting or on the server having answered:
  // - every refusal the server gives this sign-in, before its age or anything else is judged;
  // - every time the saved sign-in is found past its role's limit, answer or no answer.
  // Either answers false when the phone could not save it: the gate then asks again after
  // LOCKED_RETRY_MS, whatever the refusal, until it can. `answer`: what ask() answered.
  onRefused?: (reason: Extract<GateState, { kind: 'locked' }>['reason'], answer: MeAnswer) => boolean | void;
  onExpired?: () => boolean | void;
  // - False when the work on the phone may no longer be sent. Asked
  //   after every answer, by checkSession() (the page shown again, every minute) and, with
  //   `opening`, just before the network would go on because the server let the person in,
  //   whatever the answer or the sign-in's age; the gate then stops for good, with the network off.
  //   With `opening`, the lock that still stands when the phone could not save that it is lifted:
  //   the network stays off, the gate shows the lock and asks again after LOCKED_RETRY_MS.
  mayOpen?: (opening: boolean) => boolean | Extract<GateState, { kind: 'locked' }>;
  // The gate's owner stopped it (stop()); not called when the gate stops itself on mayOpen.
  onStopped?: () => void;
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
  // What the running check is waiting for, each a function that calls the wait off.
  private waits = new Set<() => void>();
  // Bumped when the signal goes, the page is hidden or the gate stops: an answer asked for before
  // then is not acted on.
  private epoch = 0;
  // The page is hidden: the network stays off and nothing is asked until resume().
  private suspended = false;
  // App Check tokens that would not come in monitor mode, counted on the phone only (no telemetry).
  appCheckMisses = 0;

  constructor(private readonly deps: GateDeps) {
    this.state = deps.initial ?? { kind: 'starting' };
    this.suspended = deps.startSuspended === true;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private sessionOk(): boolean {
    return this.deps.sessionValid ? this.deps.sessionValid(this.now()) : true;
  }

  // The saved sign-in's age, judged now (a timer, the page shown again): past the role's limit,
  // the network goes off and the gate is 'expired', whatever it was.
  checkSession(): void {
    if (this.retired() || this.sessionOk()) return;
    this.noteExpired();
    if (this.state.kind === 'expired') return;
    this.epoch += 1;
    this.callOff();
    void this.closeNetwork();
    this.set({ kind: 'expired' });
  }

  // The page was hidden: the network goes off, and nothing is asked until it is shown again.
  async suspend(): Promise<void> {
    if (this.stopped) return;
    this.suspended = true;
    await this.networkLost();
  }

  resume(): void {
    this.suspended = false;
    this.checkSession();
    this.poke();
  }

  current(): GateState {
    return this.state;
  }

  start(): void {
    void this.check();
  }

  stop(): void {
    this.halt();
    this.deps.onStopped?.();
  }

  private halt(): void {
    this.stopped = true;
    this.epoch += 1;
    this.callOff();
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
  }

  // The saved sign-in is past its role's limit: said every time it is found so, and asked about
  // again when the phone could not save it.
  private noteExpired(): void {
    if (this.deps.onExpired?.() === false) this.later(LOCKED_RETRY_MS);
  }

  // Ask now (an `online` event, the app shown again, a tap): a check still waiting for an answer is
  // called off, and a new one starts at once.
  poke(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      this.callOff();
      return;
    }
    clearTimeout(this.timer);
    void this.check();
  }

  // The signal went: the network goes off until /api/me has answered again, so a long gap cannot
  // let queued writes out ahead of a renewal.
  async networkLost(): Promise<void> {
    if (this.stopped) return;
    this.epoch += 1;
    this.callOff();
    await this.closeNetwork();
    if (this.state.kind === 'open') this.set({ kind: 'offline' });
  }

  // True when the gate has stopped, or stops now because the work may no longer be sent (mayOpen);
  // the lock mayOpen says still stands.
  private retired(opening = false): boolean | Extract<GateState, { kind: 'locked' }> {
    if (this.stopped) return true;
    const may = this.deps.mayOpen?.(opening) ?? true;
    if (may === true) return false;
    if (may !== false) return may;
    this.halt();
    void this.closeNetwork().catch(() => undefined);
    return true;
  }

  private set(state: GateState): void {
    this.state = state;
    this.deps.onState(state);
  }

  // `promise`'s answer, `otherwise` when it fails or has not answered within `ms`, and CALLED_OFF
  // once callOff() is called first.
  private wait<T>(promise: Promise<T>, ms: number, otherwise: T): Promise<T | typeof CALLED_OFF> {
    return new Promise((done) => {
      const finish = (value: T | typeof CALLED_OFF) => {
        clearTimeout(timer);
        this.waits.delete(off);
        done(value);
      };
      const off = () => finish(CALLED_OFF);
      const timer = setTimeout(() => finish(otherwise), ms);
      this.waits.add(off);
      promise.then(finish, () => finish(otherwise));
    });
  }

  private callOff(): void {
    for (const off of [...this.waits]) off();
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
  private async appCheckPasses(): Promise<boolean | typeof CALLED_OFF> {
    const seam = this.deps.appCheck;
    if (!seam) return true;
    const token = seam.token().then(() => true);
    if (seam.mode === 'monitor') {
      const got = await this.wait(token, APP_CHECK_MONITOR_WAIT_MS, false);
      if (got === CALLED_OFF) return got;
      if (!got) this.appCheckMisses += 1;
      return true;
    }
    return this.wait(token, APP_CHECK_ENFORCE_WITHIN_MS, false);
  }

  private async check(): Promise<void> {
    if (this.stopped || this.running || this.suspended) return;
    this.running = true;
    try {
      const epoch = this.epoch;
      const session = this.deps.session?.();
      const stale = () => {
        if (this.stopped) return true;
        if (this.epoch === epoch && this.deps.session?.() === session) return false;
        this.again = true;
        return true;
      };
      const expire = async (): Promise<void> => {
        this.noteExpired();
        await this.closeNetwork();
        if (!stale()) this.set({ kind: 'expired' });
      };
      // A wait called off asks again at once (finally, below), with nothing published.
      const calledOff = () => {
        this.again = true;
      };
      const answer = await this.wait(this.deps.ask(), ASK_WITHIN_MS, NO_ANSWER);
      if (answer === CALLED_OFF) return calledOff();
      if (stale() || this.retired()) return;
      let verdict = judgeMe(answer, this.now());
      let refusalSaved = true;
      if (verdict.kind === 'locked') {
        refusalSaved = this.deps.onRefused?.(verdict.reason, answer) !== false;
        if (stale()) return;
      }
      if (!this.sessionOk()) return await expire();
      if (verdict.kind === 'open') {
        const passes = await this.appCheckPasses();
        if (passes === CALLED_OFF) return calledOff();
        if (stale()) return;
        if (!this.sessionOk()) return await expire();
        if (!passes) {
          // Under enforcement nothing is sent without a token, an already open network included.
          await this.closeNetwork();
          if (stale()) return;
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
        if (stale()) return;
        this.set({ kind: 'renewing' });
        this.later(this.renewWait);
        this.renewWait = Math.min(this.renewWait * 2, RENEW_MAX_MS);
        return;
      }
      this.renewWait = RENEW_FIRST_MS;
      if (verdict.kind === 'locked') {
        await this.closeNetwork();
        if (stale()) return;
        this.set(verdict);
        // A disabled member or an inactive company can be let back in by the owner; the other
        // refusals need the person to sign in again, which starts a new gate. A refusal the phone
        // could not save is asked for again whichever it is.
        if (!refusalSaved || verdict.reason === 'member-disabled' || verdict.reason === 'company-inactive') this.later(LOCKED_RETRY_MS);
        return;
      }
      const still = this.retired(true);
      if (still === true) return;
      if (still) {
        await this.closeNetwork();
        if (stale()) return;
        this.set(still);
        this.later(LOCKED_RETRY_MS);
        return;
      }
      if (!this.networkOn) {
        this.networkOn = true;
        await this.deps.enableNetwork();
      }
      if (stale()) {
        await this.closeNetwork().catch(() => undefined);
        return;
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
