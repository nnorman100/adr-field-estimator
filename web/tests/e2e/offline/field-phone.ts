// A window at the field test page (harness/field.ts, S6-3) and the lane's stand-in for GET /api/me.
import type { BrowserContext, Page } from '@playwright/test';
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
  lane.serve('/api/me', { type: 'application/json', status: 'error' in answer ? answer.status : 200, body: JSON.stringify(body) });
}

export const inDays = (days: number): Date => new Date(Date.now() + days * DAY);
