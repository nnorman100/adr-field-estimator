import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { openDatabase } from '@/db/client';
import { applyMigrations, migrationsDirectory } from '@/db/migrate';
import { actors, companies, memberships, schema } from '@/db/schema';
import { emptyDiscardDatabase, startDisposablePostgres, type DisposablePostgres } from './postgres-harness';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

let disposable: DisposablePostgres;
let sql: postgres.Sql;

beforeAll(async () => {
  disposable = await startDisposablePostgres();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await disposable?.stop();
});

beforeEach(async () => {
  await sql?.end({ timeout: 5 });
  await emptyDiscardDatabase(disposable.databaseUrl);
  sql = postgres(disposable.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
});

async function migrateAll(): Promise<void> {
  await applyMigrations(disposable.databaseUrl, migrationsDirectory);
}

async function company(tenant: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO companies (name, sign_in_slug, auth_tenant_id)
    VALUES (${`Company ${tenant}`}, ${tenant}, ${tenant})
    RETURNING id
  `;
  return row!.id;
}

async function actor(companyId: string | null, tenant: string, uid: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email)
    VALUES (${companyId}, ${tenant}, ${uid}, ${`${uid}@example.test`})
    RETURNING id
  `;
  return row!.id;
}

async function invitation(companyId: string, email: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO invitations (company_id, email, role, expires_at)
    VALUES (${companyId}, ${email}, 'estimator', now() + interval '7 days')
    RETURNING id
  `;
  return row!.id;
}

function membership(
  companyId: string,
  actorId: string,
  role: string,
  options: { status?: string; invitationId?: string | null } = {},
) {
  return sql`
    INSERT INTO memberships (company_id, actor_id, role, status, invitation_id)
    VALUES (${companyId}, ${actorId}, ${role}, ${options.status ?? 'active'}, ${options.invitationId ?? null})
  `;
}

function refusedBy(code: string, constraint: string) {
  return { code, constraint_name: constraint };
}

describe('identity tables (migration 0002)', () => {
  it('applies on a database that already holds 0001 with a company row', async () => {
    const onlyFoundation = await mkdtemp(join(tmpdir(), 'dryscope-mig-'));
    try {
      await copyFile(join(migrationsDirectory, '0001_foundation.sql'), join(onlyFoundation, '0001_foundation.sql'));
      expect((await applyMigrations(disposable.databaseUrl, onlyFoundation)).applied).toEqual(['0001_foundation']);
    } finally {
      await rm(onlyFoundation, { recursive: true, force: true });
    }
    const [existing] = await sql<{ id: string; created_at: Date }[]>`
      INSERT INTO companies DEFAULT VALUES RETURNING id, created_at
    `;

    expect((await applyMigrations(disposable.databaseUrl, migrationsDirectory)).applied).toEqual(['0002_identity']);

    const rows = await sql<
      { id: string; created_at: Date; name: string; status: string; sign_in_slug: null; auth_tenant_id: null }[]
    >`SELECT id, created_at, name, status, sign_in_slug, auth_tenant_id FROM companies`;
    expect(rows).toEqual([
      {
        id: existing!.id,
        created_at: existing!.created_at,
        name: 'Unnamed company',
        status: 'active',
        sign_in_slug: null,
        auth_tenant_id: null,
      },
    ]);
    // New companies must name themselves; the placeholder was only for rows made before 0002.
    await expect(sql`INSERT INTO companies DEFAULT VALUES`).rejects.toMatchObject({ code: '23502' });
  });

  it('refuses a second active owner in one company', async () => {
    await migrateAll();
    const a = await company('tenant-a');
    const b = await company('tenant-b');
    const firstOwner = await actor(a, 'tenant-a', 'owner-1');
    const secondOwner = await actor(a, 'tenant-a', 'owner-2');
    await membership(a, firstOwner, 'owner');

    await expect(membership(a, secondOwner, 'owner')).rejects.toMatchObject(
      refusedBy(UNIQUE_VIOLATION, 'memberships_one_active_owner'),
    );

    // A disabled owner does not count, and another company has its own owner.
    await sql`UPDATE memberships SET status = 'disabled' WHERE actor_id = ${firstOwner}`;
    await membership(a, secondOwner, 'owner');
    await membership(b, await actor(b, 'tenant-b', 'owner-1'), 'owner');
    await expect(
      sql`UPDATE memberships SET status = 'active' WHERE actor_id = ${firstOwner}`,
    ).rejects.toMatchObject(refusedBy(UNIQUE_VIOLATION, 'memberships_one_active_owner'));
  });

  it('refuses a second active membership for one actor', async () => {
    await migrateAll();
    const a = await company('tenant-a');
    const person = await actor(a, 'tenant-a', 'estimator-1');
    await membership(a, person, 'estimator');

    await expect(membership(a, person, 'office')).rejects.toMatchObject(
      refusedBy(UNIQUE_VIOLATION, 'memberships_one_active_per_actor'),
    );

    await membership(a, person, 'office', { status: 'disabled' });
    const [count] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memberships WHERE actor_id = ${person} AND status = 'active'
    `;
    expect(count?.count).toBe('1');
  });

  it('keeps (auth_tenant_id, uid) unique', async () => {
    await migrateAll();
    const a = await company('tenant-a');
    const b = await company('tenant-b');
    await actor(a, 'tenant-a', 'same-uid');

    await expect(actor(a, 'tenant-a', 'same-uid')).rejects.toMatchObject(
      refusedBy(UNIQUE_VIOLATION, 'actors_tenant_uid_key'),
    );
    await expect(actor(b, 'tenant-a', 'same-uid')).rejects.toMatchObject(
      refusedBy(UNIQUE_VIOLATION, 'actors_tenant_uid_key'),
    );
    await expect(actor(null, 'tenant-a', 'same-uid')).rejects.toMatchObject(
      refusedBy(UNIQUE_VIOLATION, 'actors_tenant_uid_key'),
    );
    // The same uid in another tenant is another person.
    await actor(b, 'tenant-b', 'same-uid');
  });

  it('lets one tenant name only one company', async () => {
    await migrateAll();
    await company('tenant-a');
    await expect(
      sql`INSERT INTO companies (name, auth_tenant_id) VALUES ('Copy', 'tenant-a')`,
    ).rejects.toMatchObject(refusedBy(UNIQUE_VIOLATION, 'companies_auth_tenant_id_key'));
  });

  it('refuses a membership that points at an actor or invitation of another company', async () => {
    await migrateAll();
    const a = await company('tenant-a');
    const b = await company('tenant-b');
    const actorOfA = await actor(a, 'tenant-a', 'person-a');
    const actorOfB = await actor(b, 'tenant-b', 'person-b');
    const operator = await actor(null, 'operators', 'operator-1');
    const invitationOfA = await invitation(a, 'person-a@example.test');
    const invitationOfB = await invitation(b, 'person-b@example.test');

    await expect(membership(b, actorOfA, 'estimator')).rejects.toMatchObject(
      refusedBy(FOREIGN_KEY_VIOLATION, 'memberships_actor_fkey'),
    );
    await expect(membership(a, operator, 'estimator')).rejects.toMatchObject(
      refusedBy(FOREIGN_KEY_VIOLATION, 'memberships_actor_fkey'),
    );
    await expect(membership(b, actorOfB, 'estimator', { invitationId: invitationOfA })).rejects.toMatchObject(
      refusedBy(FOREIGN_KEY_VIOLATION, 'memberships_invitation_fkey'),
    );

    // Moving an existing membership to the other company is refused the same way.
    await membership(a, actorOfA, 'estimator', { invitationId: invitationOfA });
    await expect(
      sql`UPDATE memberships SET company_id = ${b} WHERE actor_id = ${actorOfA}`,
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });

    // An invitation is accepted only by an actor of its own company, and only once.
    await expect(
      sql`UPDATE invitations SET status = 'accepted', accepted_by_actor_id = ${actorOfA}, accepted_at = now()
          WHERE id = ${invitationOfB}`,
    ).rejects.toMatchObject(refusedBy(FOREIGN_KEY_VIOLATION, 'invitations_accepted_by_fkey'));
    await sql`UPDATE memberships SET status = 'disabled' WHERE actor_id = ${actorOfA}`;
    await expect(membership(a, actorOfA, 'office', { invitationId: invitationOfA })).rejects.toMatchObject(
      refusedBy(UNIQUE_VIOLATION, 'memberships_invitation_id_key'),
    );

    // The access outbox is held to the same company.
    await expect(
      sql`INSERT INTO access_projection_outbox (company_id, actor_id) VALUES (${b}, ${actorOfA})`,
    ).rejects.toMatchObject(refusedBy(FOREIGN_KEY_VIOLATION, 'access_projection_outbox_actor_fkey'));
  });

  it('matches the typed schema to the tables the migrations create', async () => {
    await migrateAll();
    const rows = await sql<{ table_name: string; column_name: string; is_nullable: 'YES' | 'NO' }[]>`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name
    `;
    const database = rows.map((row) => `${row.table_name}.${row.column_name}:${row.is_nullable === 'NO'}`).sort();
    const typed = Object.values(schema as Record<string, PgTable>)
      .flatMap((table) => {
        const config = getTableConfig(table);
        return config.columns.map((column) => `${config.name}.${column.name}:${column.notNull}`);
      })
      .sort();
    expect(typed).toEqual(database);

    // The typed view writes and reads the new tables.
    const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: disposable.databaseUrl });
    try {
      const [created] = await handle.db.insert(companies).values({ name: 'Typed', authTenantId: 'typed' }).returning();
      const [person] = await handle.db
        .insert(actors)
        .values({ companyId: created!.id, authTenantId: 'typed', uid: 'u1', email: 'u1@example.test' })
        .returning();
      const [member] = await handle.db
        .insert(memberships)
        .values({ companyId: created!.id, actorId: person!.id, role: 'owner' })
        .returning();
      expect(created?.status).toBe('active');
      expect(member?.status).toBe('active');
    } finally {
      await handle.close();
    }
  });
});
