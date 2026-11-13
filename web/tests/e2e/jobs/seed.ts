// A company of its own for one job-screen test (tests/e2e/jobs.spec.ts): a sign-in tenant and
// people in the Auth emulator, and the same company, people and memberships in the throwaway
// PostgreSQL (server.ts), written as the superuser the way an operator's command would. The app then
// finds them exactly as in production: the sign-in address in `companies`, each sign-in in `actors`
// and `memberships`, and /api/me writes the field database access records itself. A test never
// meets another's data, so the tests run side by side.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createTenant, createUser } from '../sign-in/emulator';
import { PASSWORD } from '../sign-in/seed';
import { JOBS_STATE, type JobsState } from './backend';

export type Role = 'owner' | 'estimator' | 'office';
export type Person = { email: string; uid: string; role: Role };
export type Company = { id: string; name: string; address: string; tenantId: string; people: Record<string, Person> };

let sql: postgres.Sql | null = null;

// The test database as its superuser, for seeding and for reading back what the app stored.
export function adminSql(): postgres.Sql {
  if (!sql) {
    const { adminUrl } = JSON.parse(readFileSync(JOBS_STATE, 'utf8')) as JobsState;
    sql = postgres(adminUrl, { max: 2, connect_timeout: 10, onnotice: () => {} });
  }
  return sql;
}

export async function seedCompany(label: string, people: Record<string, Role>): Promise<Company> {
  const run = randomUUID().slice(0, 8);
  const tenantId = await createTenant(`jobs-${label}-${run}`);
  const address = `jobs-${label}-${run}`;
  const name = `Jobs ${label} ${run} Restoration`;
  const db = adminSql();
  await db`INSERT INTO auth_tenants (id, kind) VALUES (${tenantId}, 'company')`;
  const [company] = await db<{ id: string }[]>`
    INSERT INTO companies (name, sign_in_slug, auth_tenant_id, status)
    VALUES (${name}, ${address}, ${tenantId}, 'active') RETURNING id::text
  `;
  const seeded: Record<string, Person> = {};
  for (const [who, role] of Object.entries(people)) {
    const email = `${who}-${run}@example.com`;
    const uid = await createUser(tenantId, { email, password: PASSWORD, emailVerified: true });
    const [actor] = await db<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email, display_name)
      VALUES (${company!.id}, ${tenantId}, ${uid}, ${email}, ${who}) RETURNING id::text
    `;
    await db`INSERT INTO memberships (company_id, actor_id, role, status) VALUES (${company!.id}, ${actor!.id}, ${role}, 'active')`;
    seeded[who] = { email, uid, role };
  }
  return { id: company!.id, name, address, tenantId, people: seeded };
}

// What the database holds for a company: its jobs, and each job's registered photos.
export async function storedJobs(companyId: string): Promise<{ id: string; propertyAddress: string }[]> {
  return adminSql()<{ id: string; propertyAddress: string }[]>`
    SELECT id::text, property_address AS "propertyAddress" FROM jobs WHERE company_id = ${companyId}
  `;
}

export async function storedPhotos(companyId: string, jobId: string): Promise<{ objectId: string; kind: string }[]> {
  return adminSql()<{ objectId: string; kind: string }[]>`
    SELECT object_id::text AS "objectId", kind FROM evidence_objects WHERE company_id = ${companyId} AND job_id = ${jobId}
  `;
}
