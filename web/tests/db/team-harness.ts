import postgres from 'postgres';
import { openDatabase } from '@/db/client';
import { databaseDirectory, databaseOperators } from '@/lib/auth/directory';
import { IdentityRefusal, type TokenVerifier } from '@/lib/auth/identity';
import type { IdentityServices, OperatorServices } from '@/lib/auth/services';
import { archiveService } from '@/lib/jobs/archive';
import { officeService } from '@/lib/jobs/office';
import { jobsService } from '@/lib/jobs/service';
import type { JobRoutesService } from '@/lib/jobs/services';
import { photosService, type PhotosService } from '@/lib/photos/service';
import { noEmailService, platformService, type PlatformService } from '@/lib/platform/service';
import { pricesService, type PricesService } from '@/lib/prices/service';
import { profileService, type ProfileService } from '@/lib/profile/service';
import { submissionsService, type SubmissionsService } from '@/lib/submissions/service';
import type { PlatformUsers } from '@/lib/platform/users';
import { teamService, type TeamService } from '@/lib/team/service';
import { TenantUsersUnavailable } from '@/lib/team/users';
import { fakeDrafts, type FakeDrafts } from './draft-fake';
import { fakeDraftStates, fakeEvidence, type FakeDraftStates, type FakeEvidence } from './evidence-fake';
import { startMigratedDatabase, type MigratedDatabase, type SharedRole } from './postgres-harness';
import { fakeField, memoryBacking, type FakeField } from '../submissions/field-fake';

// The team and invitation routes against a real Postgres, as the app's runtime role with forced
// row-level security, set up like a fresh Cloud SQL instance (see sign-in-lookup.test.ts): a
// CREATEROLE migrator owns the tables and the API user inherits dryscope_runtime. Sign-in tokens
// and the tenant's accounts are replaced by fakes; tests/emu/tenant-users.test.ts checks the real
// account calls against the Auth emulator.

export type Seed = {
  a: string;
  b: string;
  suspended: string;
  ownerA: { actor: string; membership: string };
  estimatorA: { actor: string; membership: string };
  officeA: { actor: string; membership: string };
  disabledA: { actor: string; membership: string };
  ownerB: { actor: string; membership: string };
  estimatorB: { actor: string; membership: string };
  operator: string;
};

export type TenantCall = { call: 'ensureAccount' | 'revokeSessions' | 'resetSecondStep'; tenant: string; value: string };

export type Harness = {
  server: MigratedDatabase;
  admin: postgres.Sql;
  handle: ReturnType<typeof openDatabase>;
  // The runtime's login, for a test that needs a second connection.
  apiUrl: string;
  seed: Seed;
  calls: TenantCall[];
  // Set to make the next tenant call fail as if Identity Platform were unreachable.
  failNext: { ensureAccount: boolean; revokeSessions: boolean; resetSecondStep: boolean };
  // Runs inside each revokeSessions call, before it returns.
  onRevoke: (() => Promise<void>) | null;
  identity: IdentityServices;
  // The operator routes' sign-in check: the fake verifier with the real platform_operator lookup.
  operators: OperatorServices;
  team: TeamService;
  platform: PlatformService;
  prices: PricesService;
  // The company profile routes' service (S5a-4).
  profile: ProfileService;
  // The jobs routes' services (S5a-3, S5b-1's office service and S5b-2's archive, restore and copy),
  // over the same database and in-memory stand-ins for the field drafts.
  jobs: JobRoutesService;
  drafts: FakeDrafts;
  // The photo routes' service, over the same database, an in-memory evidence bucket and the draft states.
  photos: PhotosService;
  evidence: FakeEvidence;
  draftStates: FakeDraftStates;
  // Submit and Back to editing (S5a-8), over the same database and a stand-in for the field drafts
  // linked to the two above: a draft the jobs service made is here, and the photo route sees its state.
  submissions: SubmissionsService;
  field: FakeField;
  // The migrator's login (the table owner), for the owner-run command.
  migratorUrl: string;
  // Each member the team service asked to project, in order, after its change committed.
  projected: { companyId: string; actorId: string }[];
};

function urlAs(server: MigratedDatabase, role: SharedRole): string {
  const url = new URL(server.databaseUrl);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

export async function startTeamServer(): Promise<Pick<Harness, 'server' | 'admin'>> {
  const server = await startMigratedDatabase();
  const admin = postgres(server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  return { server, admin };
}

async function seedCompanies(admin: postgres.Sql): Promise<Seed> {
  await admin`
    INSERT INTO auth_tenants (id, kind) VALUES
      ('tenant-a', 'company'), ('tenant-b', 'company'), ('tenant-s', 'company'), ('operators', 'operator')
  `;
  const company = async (tenant: string, slug: string, status = 'active') => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO companies (name, sign_in_slug, auth_tenant_id, status)
      VALUES (${`Company ${slug}`}, ${slug}, ${tenant}, ${status}) RETURNING id
    `;
    return row!.id;
  };
  const member = async (companyId: string, tenant: string, uid: string, role: string, status = 'active') => {
    const [actor] = await admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email)
      VALUES (${companyId}, ${tenant}, ${uid}, ${`${uid}@example.test`}) RETURNING id
    `;
    const [membership] = await admin<{ id: string }[]>`
      INSERT INTO memberships (company_id, actor_id, role, status)
      VALUES (${companyId}, ${actor!.id}, ${role}, ${status}) RETURNING id
    `;
    return { actor: actor!.id, membership: membership!.id };
  };
  const a = await company('tenant-a', 'company-a');
  const b = await company('tenant-b', 'company-b');
  const suspended = await company('tenant-s', 'company-s', 'suspended');
  const seed = {
    a,
    b,
    suspended,
    ownerA: await member(a, 'tenant-a', 'owner-a', 'owner'),
    estimatorA: await member(a, 'tenant-a', 'estimator-a', 'estimator'),
    officeA: await member(a, 'tenant-a', 'office-a', 'office'),
    disabledA: await member(a, 'tenant-a', 'disabled-a', 'estimator', 'disabled'),
    ownerB: await member(b, 'tenant-b', 'owner-b', 'owner'),
    estimatorB: await member(b, 'tenant-b', 'estimator-b', 'estimator'),
  };
  const [operator] = await admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email)
    VALUES (NULL, 'operators', 'operator-1', 'operator-1@example.test') RETURNING id
  `;
  await admin`INSERT INTO platform_admins (actor_id) VALUES (${operator!.id})`;
  return { ...seed, operator: operator!.id };
}

// Claims a fake token carries; the fake verifier below trusts them.
export type FakeClaims = {
  tenant: string | null;
  uid: string;
  email?: string;
  name?: string;
  verified?: boolean;
  revoked?: boolean;
  // Seconds before now that the person signed in; a minute by default.
  signedInAgo?: number;
  secondFactor?: string | null;
};

export function fakeVerifier(): TokenVerifier {
  const read = (idToken: string): FakeClaims =>
    JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as FakeClaims;
  return {
    async verify(idToken) {
      const claims = read(idToken);
      return { tenant: claims.tenant, uid: claims.uid, emailVerified: claims.verified ?? true };
    },
    async verifyNotRevoked(idToken, tenant) {
      const claims = read(idToken);
      if (claims.tenant !== tenant) throw new IdentityRefusal('invalid_token');
      if (claims.revoked) throw new IdentityRefusal('sign_in_revoked');
      return {
        tenant: claims.tenant,
        uid: claims.uid,
        emailVerified: claims.verified ?? true,
        authTime: Math.floor(Date.now() / 1000) - (claims.signedInAgo ?? 60),
        // An authenticator app by default, so an owner meets the session rules.
        secondFactor: claims.secondFactor === undefined ? 'totp' : claims.secondFactor,
        email: claims.email ?? `${claims.uid}@example.test`,
        name: claims.name ?? null,
      };
    },
  };
}

export function request(
  claims: FakeClaims | null,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Request {
  const headers = new Headers();
  if (claims) {
    headers.set('Authorization', `Bearer e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`);
  }
  const raw = init.body instanceof Uint8Array;
  if (init.body !== undefined) headers.set('Content-Type', raw ? 'application/octet-stream' : 'application/json');
  return new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers,
    body:
      init.body === undefined ? undefined : typeof init.body === 'string' || raw ? (init.body as BodyInit) : JSON.stringify(init.body),
  });
}

export const params = (values: Record<string, string>) => ({ params: Promise.resolve(values) });

// A fresh database with the seed, a runtime-role connection and fake tenant accounts.
export async function resetTeamDatabase(
  base: Pick<Harness, 'server' | 'admin'>,
  previous: Harness | null,
): Promise<Harness> {
  await previous?.handle.close();
  const { server } = base;
  // A fresh copy of the migrated template: an empty public schema as a new database has it, every
  // migration applied by the migrator, no rows. Its connections end with the old copy.
  await base.admin.end({ timeout: 5 });
  await server.reset();
  const admin = postgres(server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  base.admin = admin;
  const seed = await seedCompanies(admin);
  const apiUrl = urlAs(server, server.roles.api);
  const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: apiUrl });
  const record = memoryBacking();
  const harness: Harness = {
    server,
    admin,
    handle,
    apiUrl,
    seed,
    calls: [],
    failNext: { ensureAccount: false, revokeSessions: false, resetSecondStep: false },
    onRevoke: null,
    identity: { verifier: fakeVerifier(), directory: databaseDirectory(handle.db) },
    operators: { verifier: fakeVerifier(), operators: databaseOperators(handle.db) },
    team: null as unknown as TeamService,
    platform: null as unknown as PlatformService,
    prices: pricesService(handle.db),
    profile: profileService(handle.db),
    jobs: null as unknown as JobRoutesService,
    // One field record for every field stand-in (tests/submissions/field-fake.ts).
    drafts: fakeDrafts(record),
    photos: null as unknown as PhotosService,
    evidence: fakeEvidence(),
    draftStates: null as unknown as FakeDraftStates,
    submissions: null as unknown as SubmissionsService,
    field: null as unknown as FakeField,
    migratorUrl: urlAs(server, server.roles.migrator),
    projected: [],
  };
  const users: PlatformUsers = {
    async ensureAccount(tenant, email) {
      harness.calls.push({ call: 'ensureAccount', tenant, value: email });
      if (harness.failNext.ensureAccount) {
        harness.failNext.ensureAccount = false;
        throw new TenantUsersUnavailable();
      }
    },
    async revokeSessions(tenant, uid) {
      harness.calls.push({ call: 'revokeSessions', tenant, value: uid });
      await harness.onRevoke?.();
      if (harness.failNext.revokeSessions) {
        harness.failNext.revokeSessions = false;
        throw new TenantUsersUnavailable();
      }
    },
    async resetSecondStep(tenant, uid) {
      harness.calls.push({ call: 'resetSecondStep', tenant, value: uid });
      if (harness.failNext.resetSecondStep) {
        harness.failNext.resetSecondStep = false;
        throw new TenantUsersUnavailable();
      }
    },
  };
  const projectInto = async (companyId: string, actorId: string) => {
    harness.projected.push({ companyId, actorId });
  };
  harness.platform = platformService(handle.db, users, projectInto, noEmailService);
  harness.team = teamService(handle.db, users, projectInto);
  harness.draftStates = fakeDraftStates(record);
  harness.photos = photosService(handle.db, harness.evidence, harness.draftStates);
  harness.field = fakeField(record);
  harness.jobs = {
    ...jobsService(handle.db, harness.drafts),
    ...officeService(handle.db, harness.drafts, harness.field),
    ...archiveService(handle.db, harness.field),
  };
  harness.submissions = submissionsService(handle.db, harness.field);
  return harness;
}

// Every row of every table, to prove a refused request changed nothing.
export async function everything(admin: postgres.Sql): Promise<string> {
  const tables = await admin<{ name: string }[]>`
    SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname
  `;
  const dump: Record<string, unknown> = {};
  for (const { name } of tables) dump[name] = await admin.unsafe(`SELECT * FROM "${name}" ORDER BY 1`);
  return JSON.stringify(dump);
}

export const owner = (uid = 'owner-a', tenant = 'tenant-a'): FakeClaims => ({ tenant, uid });

// The seeded platform operator, signed in with an authenticator app a minute ago.
export const operatorClaims = (extra: Partial<FakeClaims> = {}): FakeClaims => ({ tenant: 'operators', uid: 'operator-1', ...extra });
