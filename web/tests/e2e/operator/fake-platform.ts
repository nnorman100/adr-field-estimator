import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import type { CompanyView } from '../../../src/lib/platform/service';
import type { SupportJobListItem, SupportJobView } from '../../../src/lib/platform/support-jobs';
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
  // While set, reading the company list fails as the server being unavailable.
  listUnavailable = false;
  // While set, an image read is refused as for an operator turned off, or fails as a dropped connection.
  images: 'answer' | 'not-an-operator' | 'no-connection' = 'answer';
  // Company A's jobs for the support view (S5b-5): two, so a page of one leaves a second to show.
  jobs: SupportJobListItem[] = [];
  // The signed job's detail, with one photo and its signature, and the bytes the photo route sends.
  detail: Omit<SupportJobView, 'company'> | null = null;
  readonly photoBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

  constructor() {
    this.companies = [
      this.company('Company A Restoration', 'company-a', true),
      this.company('Company C Restoration', 'company-c', false),
    ];
    this.members = [
      member('Olivia Owner', 'olivia@example.com', 'owner'),
      member('Eddie Estimator', 'eddie@example.com', 'estimator'),
    ];
    const signed = supportJob('12 Synthetic Way', 'Pat Customer', 'signed');
    this.jobs = [signed, supportJob('3 Archived Lane', '', 'archived')];
    this.detail = signedDetail(signed);
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
      if (method === 'GET') return this.listUnavailable ? json(503, { error: 'unavailable' }) : json(200, { companies: this.companies });
      const input = body as { name: string; signInSlug: string };
      if (this.companies.some((company) => company.signInSlug === input.signInSlug)) return json(409, { error: 'sign_in_address_taken' });
      const company = this.company(input.name, input.signInSlug, false);
      this.companies.push(company);
      return json(201, { company });
    }

    const jobs = /^\/api\/platform\/companies\/([^/]+)\/jobs(?:\/([^/]+)(?:\/photos\/([^/]+))?)?$/.exec(path);
    if (jobs) return this.answerJobs(route, jobs[1]!, jobs[2], jobs[3]);

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

  // The support view's three reads, with the real routes' rules: a page of one job and a cursor for
  // the next; a job or photo of another company is not found; a photo needs exactly one kind.
  private async answerJobs(route: Route, companyId: string, jobId: string | undefined, photoId: string | undefined): Promise<void> {
    const url = new URL(route.request().url());
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(payload) });
    const company = this.companies.find((candidate) => candidate.id === companyId);
    const own = company?.name === 'Company A Restoration';
    if (!company) return json(404, { error: 'not_found' });
    if (jobId === undefined) {
      const list = own ? this.jobs : [];
      const at = url.searchParams.get('cursor') === 'second-page' ? 1 : 0;
      return json(200, { company, jobs: list.slice(at, at + 1), nextCursor: at === 0 && list.length > 1 ? 'second-page' : null });
    }
    const detail = own && this.detail?.job.id === jobId ? this.detail : null;
    if (!detail) return json(404, { error: 'not_found' });
    if (photoId === undefined) return json(200, { company, ...detail });
    const kinds = url.searchParams.getAll('kind');
    if (kinds.length !== 1) return json(400, { error: 'invalid_request' });
    const item = detail.evidence.find((candidate) => candidate.photoId === photoId && candidate.kind === kinds[0]);
    if (!item) return json(404, { error: 'not_found' });
    if (this.images === 'not-an-operator') return json(403, { error: 'not_an_operator' });
    if (this.images === 'no-connection') return route.abort('internetdisconnected');
    return route.fulfill({ status: 200, contentType: item.contentType, headers: { 'cache-control': 'no-store' }, body: this.photoBytes });
  }
}

function supportJob(propertyAddress: string, customerName: string, status: SupportJobListItem['status']): SupportJobListItem {
  const at = new Date().toISOString();
  return { id: randomUUID(), status, propertyAddress, revision: 3, createdAt: at, updatedAt: at, customerName };
}

// A signed job as the server's job view answers it: the customer and claim, the signed record with
// its proposal, and the evidence list (one photo and the agreement's signature, no object path).
function signedDetail(job: SupportJobListItem): Omit<SupportJobView, 'company'> {
  const at = new Date().toISOString();
  const photoId = randomUUID();
  const signatureId = randomUUID();
  const end = { subtotal: '240.00', after_hours: '0.00', trade_minimums: [], minimum_charge: '0.00', overhead_profit: '0.00', tax: '0.00', total: '240.00' };
  return {
    job: { id: job.id, status: 'signed', currentDraftId: randomUUID(), fieldOwnerActorId: null, propertyAddress: job.propertyAddress, revision: 3, createdAt: at, updatedAt: at },
    customer: { name: 'Pat Customer', phone: '555-0100', email: 'pat@example.com' },
    claim: { carrier: 'Carrier Co', claimNumber: 'CLM-1', policyNumber: '', dateOfLoss: '2026-11-01', lossCause: 'Pipe burst', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '' },
    agreement: {
      id: randomUUID(),
      jobId: job.id,
      signedAt: at,
      documentsSha256: 'a'.repeat(64),
      record: {
        format: 'dryscope-signed-v1',
        agreement_id: randomUUID(),
        job_id: job.id,
        kind: 'original',
        signed_at: at,
        signer: { name: 'Pat Customer' },
        signed_with: { kind: 'device', presented_by: { actor_id: randomUUID(), name: 'Eddie Estimator' } },
        signature: { id: randomUUID(), sha256: 'b'.repeat(64), content_type: 'image/png' },
        proposal_sha256: 'c'.repeat(64),
        proposal: {
          format: 'dryscope-proposal-v2',
          heading: 'Company A Restoration · Official proposal',
          letterhead: ['Company A Restoration'],
          customer_name: 'Pat Customer',
          property_address: job.propertyAddress,
          lead_notice_required: false,
          disclaimers: [],
          findings: ['Wet carpet by the sink.'],
          recommendations: ['Dry the kitchen.'],
          price: { mode: 'single', itemized_total: '240.00', low: end, high: null, explanation: null, after_hours_label: 'After hours' },
          basis: { submission_id: randomUUID(), snapshot_sha256: 'd'.repeat(64), price_version: 1, content_sha256: 'e'.repeat(64), engine_version: 'dryscope-v3' },
        },
        documents: { itemized_claim: [], letter: 'Synthetic scope defense letter.', photo_log: [{ id: photoId, room: 'Kitchen', shot_tag: 'Overview', sha256: 'f'.repeat(64) }], claim: {}, compliance_notes: [] },
        basis: { estimate_id: randomUUID(), submission_id: randomUUID() },
      },
    },
    evidence: [
      { photoId, kind: 'photo', sha256: 'f'.repeat(64), sizeBytes: 2048, contentType: 'image/png', createdAt: at },
      { photoId: signatureId, kind: 'signature', sha256: '0'.repeat(64), sizeBytes: 1024, contentType: 'image/png', createdAt: at },
    ],
  };
}

function member(displayName: string, email: string, role: MemberView['role']): MemberView {
  return { membershipId: randomUUID(), actorId: randomUUID(), displayName, email, role, status: 'active' };
}
