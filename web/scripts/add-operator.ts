// Owner-run command (owner decision D6): add one platform operator. There is no API for this, by
// design. The person's account must already exist in the operator tenant (made in the Console;
// create the tenant first with `npm run platform:create-tenant`). Run it the way `npm run
// db:migrate` is run, signed in as the database owner itself (the migrator, dryscope-migrate-<env>):
// migration 0006's add_platform_operator accepts no one else, and nobody but the table owner may
// execute it.
//
//   npm run platform:add-operator -- --tenant <operator tenant id> --uid <user uid> --email <email>
//
// Reads DATABASE_URL (or the SQL_* settings) like db:migrate, and .env.local when present. Prints
// the operator's actor id only, never the email or the connection string.
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { connectionOptions } from '../src/db/client';
import { parseConfig } from '../src/lib/config';

export type OperatorInput = { tenant: string; uid: string; email: string };

const TENANT_ID = /^[A-Za-z0-9-]{1,128}$/;
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseOperatorArgs(argv: string[]): OperatorInput {
  const names = ['tenant', 'uid', 'email'];
  argv.forEach((arg, i) => {
    if (arg.startsWith('--') && !names.includes(arg.slice(2))) throw new Error(`unknown option ${arg}`);
    if (!arg.startsWith('--') && !names.includes((argv[i - 1] ?? '').slice(2))) throw new Error('unexpected argument');
  });
  const value = (name: string): string => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v || v.startsWith('--')) throw new Error(`--${name} is required`);
    return v;
  };
  const tenant = value('tenant');
  if (!TENANT_ID.test(tenant)) throw new Error('--tenant must be an Identity Platform tenant id');
  const uid = value('uid');
  if (!UID.test(uid)) throw new Error('--uid must be the account uid from the Console');
  const email = value('email').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new Error('--email must be an email address');
  return { tenant, uid, email };
}

// Runs the command on one connection; returns the operator's actor id.
export async function addOperator(sql: postgres.Sql, input: OperatorInput): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    SELECT add_platform_operator(${input.tenant}, ${input.uid}, ${input.email})::text AS id
  `;
  if (!row?.id) throw new Error('the operator was not added');
  return row.id;
}

async function main() {
  const input = parseOperatorArgs(process.argv.slice(2));
  try {
    process.loadEnvFile('.env.local');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { url, options } = connectionOptions(parseConfig(process.env));
  const sql = url === null ? postgres(options) : postgres(url, options);
  try {
    console.log(`operator: ${await addOperator(sql, input)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // A database error names the problem (for example a company tenant); it never holds the URL.
    const message = error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database]') : '';
    console.error(message || 'adding the operator failed');
    process.exit(1);
  });
}
