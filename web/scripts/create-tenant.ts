// Owner-run command (owner decision D4): create one Identity Platform sign-in tenant, for a new
// company or for the platform operators (D6). It runs with the person's own Google credentials
// (`gcloud auth application-default login`), never the app's: the app's account holds only the
// narrow per-tenant user role (infra/dryscope, S3-5) and can never create a tenant.
//
//   npm run platform:create-tenant -- --project dryscope --name test-company-a
//   npm run platform:create-tenant -- --project dryscope --name test-operators --dry-run
//
// The tenant gets password sign-in, no public sign-up, no account deletion by the user, and
// authenticator-app (TOTP) second steps (D1), as in docs/plans/S3.md section 6, step 5. It prints
// the new tenant id. A company tenant is then bound to its company with the operator route
// POST /api/platform/companies/{id}/tenant; an operator tenant is registered by
// `npm run platform:add-operator`. Binding the app's user role on the tenant (step 7) and turning
// Google sign-in on (step 9) stay separate owner steps. Prints no token.
import { pathToFileURL } from 'node:url';

export type TenantOptions = { project: string; name: string; dryRun: boolean };

// A Google Cloud project id, and an Identity Platform display name: 4-20 letters, digits and
// hyphens, starting with a letter (docs.cloud.google.com/identity-platform/docs/multi-tenancy-managing-tenants).
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DISPLAY_NAME = /^[A-Za-z][A-Za-z0-9-]{3,19}$/;

export function parseTenantArgs(argv: string[]): TenantOptions {
  const value = (name: string): string => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v || v.startsWith('--')) throw new Error(`--${name} is required`);
    return v;
  };
  const known = new Set(['--project', '--name', '--dry-run']);
  argv.forEach((arg, i) => {
    if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown option ${arg}`);
    if (!arg.startsWith('--') && !['--project', '--name'].includes(argv[i - 1] ?? '')) {
      throw new Error(`unexpected argument ${arg}`);
    }
  });
  const project = value('project');
  if (!PROJECT_ID.test(project)) throw new Error('--project must be a Google Cloud project id');
  const name = value('name');
  if (!DISPLAY_NAME.test(name)) {
    throw new Error('--name must be 4-20 letters, digits and hyphens, starting with a letter');
  }
  return { project, name, dryRun: argv.includes('--dry-run') };
}

// The tenant body (Identity Platform v2 projects.tenants).
export function tenantBody(name: string) {
  return {
    displayName: name,
    allowPasswordSignup: true,
    enableEmailLinkSignin: false,
    client: { permissions: { disabledUserSignup: true, disabledUserDeletion: true } },
    mfaConfig: { state: 'ENABLED', providerConfigs: [{ state: 'ENABLED', totpProviderConfig: { adjacentIntervals: 1 } }] },
  };
}

export type CreateTenantDeps = {
  accessToken: () => Promise<string>;
  fetch: typeof fetch;
};

// Returns the new tenant id. Any failure names only the HTTP status, never the response text,
// which can echo request details.
export async function createTenant(options: TenantOptions, deps: CreateTenantDeps): Promise<string> {
  const url = `https://identitytoolkit.googleapis.com/v2/projects/${options.project}/tenants`;
  const token = await deps.accessToken();
  const response = await deps.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': options.project,
    },
    body: JSON.stringify(tenantBody(options.name)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`creating the tenant failed with status ${response.status}`);
  const created = (await response.json()) as { name?: unknown };
  const match = typeof created.name === 'string' ? /^projects\/[^/]+\/tenants\/([A-Za-z0-9-]{1,128})$/.exec(created.name) : null;
  if (!match?.[1]) throw new Error('the tenant was created but its id could not be read');
  return match[1];
}

async function main() {
  const options = parseTenantArgs(process.argv.slice(2));
  if (options.dryRun) {
    console.log(`would create tenant ${options.name} in ${options.project}:`);
    console.log(JSON.stringify(tenantBody(options.name), null, 2));
    return;
  }
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const tenant = await createTenant(options, {
    accessToken: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error('no Google credentials: run gcloud auth application-default login');
      return token;
    },
    fetch,
  });
  console.log(`created tenant ${tenant}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'creating the tenant failed');
    process.exit(1);
  });
}
