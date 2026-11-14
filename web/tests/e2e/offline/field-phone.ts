// A window at the field test page (harness/field.ts, S6-3) and the lane's stand-in for GET /api/me.
import type { BrowserContext, Page } from '@playwright/test';
import { firebaseTokenVerifier } from '../../../src/lib/auth/firebase';
import { IdentityRefusal } from '../../../src/lib/auth/identity';
import { parseIdentityConfig, type IdentityConfig } from '../../../src/lib/config';
import { firebaseTenantUsers } from '../../../src/lib/team/users';
import { AUTH_EMULATOR_HOST, E2E_PROJECT } from '../sign-in/emulator';
import { browserConfig } from './fixture';
import type { FieldHarness, Person as FieldPerson } from './harness/field';
import type { NetworkLane } from './lane';
import type { Person, World } from './world';

export class FieldPhone {
  private constructor(
    readonly page: Page,
    readonly lane: NetworkLane,
  ) {}

  static async open(context: BrowserContext, lane: NetworkLane): Promise<FieldPhone> {
    const page = await context.newPage();
    await page.goto(`${lane.appUrl}/__harness/field/`);
    return new FieldPhone(page, lane);
  }

  call<K extends keyof FieldHarness>(method: K, ...args: Parameters<FieldHarness[K]>): Promise<Awaited<ReturnType<FieldHarness[K]>>> {
    return this.page.evaluate(
      ([name, rest]) => (window as unknown as { f: Record<string, (...a: unknown[]) => unknown> }).f[name as string]!(...(rest as unknown[])),
      [method, args] as const,
    ) as Promise<Awaited<ReturnType<FieldHarness[K]>>>;
  }

  // Who `person` is to the field code: the company tenant, the person and the lane's settings.
  person(world: Pick<World, 'tenantId'>, person: Person): FieldPerson {
    return { tenantId: world.tenantId, uid: person.uid, config: browserConfig(this.lane) };
  }

  async signIn(world: Pick<World, 'tenantId'>, person: Person): Promise<FieldPerson> {
    const { tenantId, config } = this.person(world, person);
    await this.call('signIn', { tenantId, config }, person.email, person.password);
    return this.person(world, person);
  }

  // Closes this window and opens another in the same browser: the app closed and opened again.
  async restart(context: BrowserContext): Promise<FieldPhone> {
    await this.page.close();
    return FieldPhone.open(context, this.lane);
  }
}

const DAY = 24 * 60 * 60 * 1000;

// What GET /api/me answers from now on, for every window of the lane: signed in with the access
// record running out at `expiresAt` (null: no record), or a refusal code.
export function serveMe(lane: NetworkLane, answer: { expiresAt: Date | null } | { status: number; error: string }): void {
  lane.serve('/api/me', meAnswer(answer));
}

function meAnswer(answer: { expiresAt: Date | null } | { status: number; error: string }) {
  const body =
    'error' in answer
      ? { error: answer.error }
      : {
          company: { id: 'company-field', name: 'Field Test' },
          actor: { id: 'actor-field', displayName: null },
          role: 'estimator',
          capabilities: ['scope'],
          fieldAccessExpiresAt: answer.expiresAt ? answer.expiresAt.toISOString() : null,
        };
  return { type: 'application/json', status: 'error' in answer ? answer.status : 200, body: JSON.stringify(body) };
}

// The server's sign-in check, as the app makes it (src/lib/auth/firebase.ts) against the Auth
// emulator, for the tests where an owner turns a member off and on (S6-3).
function identity(): IdentityConfig {
  // firebase-admin reads the emulator's address from the process, as the server does.
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR_HOST;
  return parseIdentityConfig({ APP_ENV: 'local', GOOGLE_CLOUD_PROJECT: E2E_PROJECT, FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST });
}

// Signs the person out everywhere with the app's own revocation (what disabling a member does).
export async function revokeSessions(tenantId: string, uid: string): Promise<void> {
  await firebaseTenantUsers(identity()).revokeSessions(tenantId, uid);
}

// GET /api/me from now on as the server answers it for one company: every sign-in is checked for
// revocation with the app's own verifier first, then the member's state (`enabled`, which a test
// changes) decides; a member let in gets a record running for 7 days.
export function serveCheckedMe(lane: NetworkLane, tenantId: string, member: { enabled: boolean }): void {
  const verifier = firebaseTokenVerifier(identity());
  lane.serve('/api/me', async (headers) => {
    const token = /^Bearer (.+)$/.exec(String(headers.authorization ?? ''))?.[1];
    if (!token) return meAnswer({ status: 401, error: 'missing_token' });
    try {
      await verifier.verifyNotRevoked(token, tenantId);
    } catch (error) {
      if (error instanceof IdentityRefusal) return meAnswer({ status: error.status, error: error.code });
      return { type: 'application/json', status: 503, body: '{}' };
    }
    if (!member.enabled) return meAnswer({ status: 403, error: 'member_disabled' });
    return meAnswer({ expiresAt: inDays(7) });
  });
}

export const inDays = (days: number): Date => new Date(Date.now() + days * DAY);
