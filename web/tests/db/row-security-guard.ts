import type postgres from 'postgres';

export type UnprotectedRelation = { name: string; reason: string };

// Every relation in the public schema must be a table with row-level security enabled and
// forced and at least one policy. A view, materialized view or foreign table would read the
// rows as its owner and skip the policies, so it is flagged too until a migration decides how
// it is protected.
export async function unprotectedRelations(sql: postgres.Sql): Promise<UnprotectedRelation[]> {
  const rows = await sql<
    { name: string; kind: string; enabled: boolean; forced: boolean; policies: number }[]
  >`
    SELECT c.relname AS name,
           c.relkind::text AS kind,
           c.relrowsecurity AS enabled,
           c.relforcerowsecurity AS forced,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY c.relname
  `;
  const found: UnprotectedRelation[] = [];
  for (const row of rows) {
    if (row.kind !== 'r' && row.kind !== 'p') {
      found.push({ name: row.name, reason: 'not a table, so row-level security does not apply' });
    } else if (!row.enabled) {
      found.push({ name: row.name, reason: 'row-level security is not enabled' });
    } else if (!row.forced) {
      found.push({ name: row.name, reason: 'row-level security is not forced' });
    } else if (row.policies === 0) {
      found.push({ name: row.name, reason: 'no policy' });
    }
  }
  return found;
}
