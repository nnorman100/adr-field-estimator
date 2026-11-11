import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ROLES } from '@/lib/access';
import type { IdentityDirectory, MemberRecord } from '@/lib/auth/identity';
import { isSignInAddress, type SignInDirectory } from './directory';

// A stand-in for the sign-in records in Postgres, read from a JSON file, so the sign-in screens can
// be driven end to end against the Auth emulator with no database (tests/e2e/sign-in). The server
// uses it only when LOCAL_SIGN_IN_FIXTURE is set, which the configuration allows only on a
// developer machine beside the Auth emulator, for a demo- project, with no database configured
// (src/lib/config.ts). It answers the same questions as the database: databaseDirectory for a
// request's identity, and the address lookup of migration 0007.
//
// The file is read on every call, so a test can write it after the server has started.

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
    }),
  ),
});
export type LocalSignInFixture = z.infer<typeof fixtureSchema>;

async function load(path: string): Promise<LocalSignInFixture> {
  return fixtureSchema.parse(JSON.parse(await readFile(path, 'utf8')));
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
