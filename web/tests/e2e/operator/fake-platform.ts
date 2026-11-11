import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import type { CompanyView } from '../../../src/lib/platform/service';
import type { InvitationView, MemberView } from '../../../src/lib/team/service';

// The platform operator routes, played by the test at the network boundary, for the operator
// screens (tests/e2e/operator.spec.ts). The Auth emulator cannot do an authenticator-app second
// step, so no emulator sign-in reaches the real operator routes' data; what the real routes answer
// to a company owner and to an operator with no second step is tested against the real server.
// This fake keeps to the real routes' shapes and rules (src/lib/platform): archive needs a
// suspended company, owner changes need a bound tenant, team and second-step changes need a fresh
// sign-in.

export type Call = { method: string; path: string; body: unknown; bearer: boolean };

export class FakePlatform {
  companies: CompanyView[] = [];
  members: MemberView[] = [];
  invitations: InvitationView[] = [];
  calls: Call[] = [];
  // While set, the routes that need a fresh sign-in refuse as a sign-in older than 15 minutes.
  stale = false;

  constructor() {
    this.companies = [
      this.company('Company A Restoration', 'company-a', true),
      this.company('Company C Restoration', 'company-c', false),
    ];
    this.members = [
      member('Olivia Owner', 'olivia@example.com', 'owner'),
      member('Eddie Estimator', 'eddie@example.com', 'estimator'),
    ];
  }

  company(name: string, signInSlug: string, tenantBound: boolean, status: CompanyView['status'] = 'active'): CompanyView {
    return { id: randomUUID(), name, signInSlug, status, tenantBound, createdAt: new Date().toISOString() };
  }

  find(name: string): CompanyView {
    return this.companies.find((company) => company.name === name)!;
  }

  // The calls made, without the sign-in checks that every call makes first.
  made(method: string, pattern: RegExp): Call[] {
    return this.calls.filter((call) => call.method === method && pattern.test(call.path));
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/platform/**', (route) => this.answer(route));
  }

  private async answer(route: Route): Promise<void> {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const text = request.postData();
    const body: unknown = text ? JSON.parse(text) : undefined;
    this.calls.push({ method, path, body, bearer: (request.headers().authorization ?? '').startsWith('Bearer ') });
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(payload) });

    if (path === '/api/platform/companies') {
      if (method === 'GET') return json(200, { companies: this.companies });
      const input = body as { name: string; signInSlug: string };
      if (this.companies.some((company) => company.signInSlug === input.signInSlug)) return json(409, { error: 'sign_in_address_taken' });
      const company = this.company(input.name, input.signInSlug, false);
      this.companies.push(company);
      return json(201, { company });
    }

    const found = /^\/api\/platform\/companies\/([^/]+)\/(status|owner|team|members\/([^/]+)\/reset-second-step)$/.exec(path);
    const company = found ? this.companies.find((candidate) => candidate.id === found[1]) : undefined;
    if (!found || !company) return json(404, { error: 'not_found' });
    const action = found[2]!;

    if (action === 'status') {
      const { status } = body as { status: CompanyView['status'] };
      if (status === 'archived' && company.status !== 'suspended') return json(409, { error: 'suspend_first' });
      company.status = status;
      return json(200, { company });
    }
    if (action !== 'team' && this.stale) return json(401, { error: 'sign_in_again' });
    if (action === 'owner') {
      const input = body as { email: string; replace: boolean };
      if (!company.tenantBound) return json(409, { error: 'company_not_ready' });
      const replaced = input.replace ? this.members.find((candidate) => candidate.role === 'owner')?.membershipId ?? null : null;
      return json(201, {
        invitation: { id: randomUUID(), email: input.email, role: 'owner', status: 'pending', expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() },
        delivery: 'copy_link',
        link: `/sign-in/${company.signInSlug}/invitations/${randomUUID()}`,
        replacedMembershipId: replaced,
      });
    }
    if (action === 'team') return json(200, { company, team: { view: 'full', members: this.members, invitations: this.invitations } });
    return json(200, { reset: true, email: 'not_sent', tellByPhone: true });
  }
}

function member(displayName: string, email: string, role: MemberView['role']): MemberView {
  return { membershipId: randomUUID(), actorId: randomUUID(), displayName, email, role, status: 'active' };
}
