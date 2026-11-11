import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ROLES } from '@/lib/access';
import type {
  IdentityDirectory,
  MemberRecord,
  OperatorDirectory,
  SessionToken,
  TokenVerifier,
} from '@/lib/auth/identity';
import { isSignInAddress, type SignInDirectory } from './directory';

// A stand-in for the sign-in records in Postgres, read from a JSON file, so the sign-in screens can
// be driven end to end against the Auth emulator with no database (tests/e2e/sign-in). The server
// uses it only when LOCAL_SIGN_IN_FIXTURE is set, which the configuration allows only on a
// developer machine beside the Auth emulator, for a demo- project, with no database configured
// (src/lib/config.ts). It answers the same questions as the database: databaseDirectory for a
// request's identity, and the address lookup of migration 0007.
//
// The file is read on every call, so a test can write it after the server has started. The team
// stand-in (src/lib/team/local-team.ts) changes it too, through updateFixture.

const fixtureSchema = z.object({
  companies: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().min(1).max(200),
      signInAddress: z.string().refine(isSignInAddress),
      tenantId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
      status: z.enum(['active', 'suspended', 'archived']),
    }),
  ),
  members: z.array(
    z.object({
      companyId: z.uuid(),
      uid: z.string().min(1).max(128),
      actorId: z.uuid(),
      displayName: z.string().max(200).nullable(),
      role: z.enum(ROLES),
      status: z.enum(['active', 'disabled']),
      // For the team screens (S3-16); a member of an older fixture has none of these.
      membershipId: z.uuid().optional(),
      email: z.string().max(254).optional(),
      // Stands in for the authenticator-app second step, which the Auth emulator cannot do: the
      // member's sign-in counts as having used one (withLocalSecondStep).
      secondStep: z.boolean().optional(),
    }),
  ),
  // Platform operators: the sign-in tenant and uid of each (the table platform_admins holds).
  operators: z
    .array(z.object({ tenantId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/), uid: z.string().min(1).max(128), operatorId: z.uuid() }))
    .default([]),
  invitations: z
    .array(
      z.object({
        id: z.uuid(),
        companyId: z.uuid(),
        email: z.string().max(254),
        role: z.enum(ROLES),
        status: z.enum(['pending', 'accepted', 'cancelled']),
        expiresAt: z.iso.datetime(),
        createdAt: z.iso.datetime(),
        clearedAt: z.iso.datetime().nullable(),
        acceptedByActorId: z.uuid().nullable(),
      }),
    )
    .default([]),
});
// What a test writes: `operators` and `invitations` may be left out. What the server reads has them (empty by default).
export type LocalSignInFixture = z.input<typeof fixtureSchema>;
export type LocalFixtureData = z.output<typeof fixtureSchema>;

async function load(path: string): Promise<LocalFixtureData> {
  return fixtureSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

// A change to the file, made whole: read, change, write beside it and rename over it, all while
// holding a lock file, so two requests changing it at the same moment (or a request reading it
// during a change) never see half of one. Used only by the local team stand-in.
export function updateFixture<T>(path: string, change: (data: LocalFixtureData) => T): T {
  const lock = `${path}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST' || tries >= 400) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const data = readFixtureSync(path);
    const result = change(data);
    writeFileSync(`${path}.tmp`, JSON.stringify(data));
    renameSync(`${path}.tmp`, path);
    return result;
  } finally {
    rmSync(lock, { force: true });
  }
}

export function readFixtureSync(path: string): LocalFixtureData {
  return fixtureSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function localSignInDirectory(path: string): SignInDirectory {
  return {
    async pageFor(address) {
      const company = (await load(path)).companies.find((c) => c.signInAddress === address);
      if (!company || company.status !== 'active') return null;
      return { companyName: company.name, tenantId: company.tenantId };
    },
  };
}

export function localIdentityDirectory(path: string): IdentityDirectory {
  return {
    async companyForTenant(tenant) {
      return (await load(path)).companies.find((c) => c.tenantId === tenant)?.id ?? null;
    },
    async member(companyId, tenant, uid): Promise<MemberRecord | null> {
      const fixture = await load(path);
      const company = fixture.companies.find((c) => c.id === companyId);
      if (!company || company.tenantId !== tenant) return null;
      const record = { id: company.id, name: company.name, status: company.status };
      const rows = fixture.members.filter((m) => m.companyId === companyId && m.uid === uid);
      // As in the database: the active membership, else a disabled one.
      const row = rows.find((m) => m.status === 'active') ?? rows[0];
      if (!row) return { company: record, actor: null, membership: null, flags: [] };
      return {
        company: record,
        actor: { id: row.actorId, displayName: row.displayName },
        membership: { role: row.role, status: row.status },
        flags: [],
      };
    },
  };
}

// The platform_operator(tenant, uid) lookup of the database, for the operator routes: the id of an
// active operator, or null for everyone else (a company owner included).
export function localOperatorDirectory(path: string): OperatorDirectory {
  return {
    async operatorFor(tenant, uid) {
      return (await load(path)).operators.find((o) => o.tenantId === tenant && o.uid === uid)?.operatorId ?? null;
    },
  };
}

// The Auth emulator cannot do the authenticator-app second step (tests/emu/totp.test.ts), so the
// owner's screens could never be reached against it. In local mode a member the fixture marks with
// `secondStep` counts as having used one; everything else about the token is the SDK's answer.
export function withLocalSecondStep(base: TokenVerifier, path: string): TokenVerifier {
  return {
    verify: (idToken) => base.verify(idToken),
    async verifyNotRevoked(idToken, tenant): Promise<SessionToken> {
      const token = await base.verifyNotRevoked(idToken, tenant);
      const fixture = await load(path);
      const company = fixture.companies.find((c) => c.tenantId === tenant);
      const marked = fixture.members.some((m) => m.companyId === company?.id && m.uid === token.uid && m.secondStep === true);
      return marked ? { ...token, secondFactor: 'totp' } : token;
    },
  };
}
