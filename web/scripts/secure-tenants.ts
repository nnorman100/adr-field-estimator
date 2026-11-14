// Owner-run command (owner decision 2026-11-14, sign-in security review F1 and F2): bring every
// sign-in tenant of a project up to the settings `npm run platform:create-tenant` now gives a new
// one: a password rule of at least 12 characters, enforced (old shorter passwords must be changed
// at the next sign-in), and email enumeration protection. Like the tenant command it runs with the
// person's own Google credentials (`gcloud auth application-default login`), never the app's,
// which cannot change tenant settings.
//
//   npm run platform:secure-tenants -- --project dryscope                 # read only: what would change
//   npm run platform:secure-tenants -- --project dryscope --apply         # change it
//   npm run platform:secure-tenants -- --project dryscope --tenant ID ... # only the tenants named
//
// Without --apply it only reads. Test and live tenants share the project, so the read lists both;
// the owner checks the list before adding --apply. A tenant that already has a rule at least as
// strong keeps it: a longer minimum and other requirements stay. Each change is sent with an
// update mask naming only what changes, and the answer is checked. Prints tenant ids and display
// names, never a token or Google's answer.
import { pathToFileURL } from 'node:url';
import { EMAIL_PRIVACY_CONFIG, MIN_PASSWORD_LENGTH, PROJECT_ID } from './create-tenant';

export type SecureOptions = { project: string; tenants: string[]; apply: boolean };

const TENANT_ID = /^[A-Za-z0-9-]{1,128}$/;

export function parseSecureArgs(argv: string[]): SecureOptions {
  let project: string | undefined;
  const tenants: string[] = [];
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply') apply = true;
    else if (arg === '--project' || arg === '--tenant') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i++;
      if (arg === '--project') project = value;
      else if (TENANT_ID.test(value)) tenants.push(value);
      else throw new Error('--tenant must be a tenant id: letters, digits and hyphens');
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!project) throw new Error('--project is required');
  if (!PROJECT_ID.test(project)) throw new Error('--project must be a Google Cloud project id');
  return { project, tenants, apply };
}

type StrengthOptions = { minPasswordLength?: number; maxPasswordLength?: number } & Record<string, unknown>;
type PasswordPolicy = {
  passwordPolicyEnforcementState?: string;
  forceUpgradeOnSignin?: boolean;
  passwordPolicyVersions?: { customStrengthOptions?: StrengthOptions }[];
};
type ChangeBody = { passwordPolicyConfig?: PasswordPolicy; emailPrivacyConfig?: { enableImprovedEmailPrivacy: boolean } };

export type TenantChange = {
  tenantId: string;
  displayName: string;
  // One line per setting that changes: what it is now, and what it becomes.
  changes: string[];
  updateMask: string[];
  body: ChangeBody;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// Google's default minimum when a rule names none.
const DEFAULT_MIN = 6;

function describeRule(policy: PasswordPolicy | null): string {
  if (!policy) return 'none';
  const state = policy.passwordPolicyEnforcementState === 'ENFORCE' ? 'enforced' : 'off';
  const min = policy.passwordPolicyVersions?.[0]?.customStrengthOptions?.minPasswordLength ?? DEFAULT_MIN;
  const kept = policy.passwordPolicyEnforcementState === 'ENFORCE' && policy.forceUpgradeOnSignin !== true ? ', old passwords kept' : '';
  return `${state}, at least ${min} characters${kept}`;
}

// What must change on one tenant (from tenants.list), or null when it already has both settings.
export function tenantChange(tenant: unknown): TenantChange | null {
  const fields = record(tenant);
  const match = typeof fields.name === 'string' ? /^projects\/[^/]+\/tenants\/([A-Za-z0-9-]{1,128})$/.exec(fields.name) : null;
  if (!match?.[1]) throw new Error('a tenant in the list could not be read');
  const tenantId = match[1];
  const displayName = typeof fields.displayName === 'string' ? fields.displayName : '';

  const changes: string[] = [];
  const updateMask: string[] = [];
  const body: ChangeBody = {};

  const current = Object.hasOwn(fields, 'passwordPolicyConfig') ? (record(fields.passwordPolicyConfig) as PasswordPolicy) : null;
  const options: StrengthOptions = { ...record(current?.passwordPolicyVersions?.[0]?.customStrengthOptions) };
  const min = typeof options.minPasswordLength === 'number' ? options.minPasswordLength : DEFAULT_MIN;
  const strong = current?.passwordPolicyEnforcementState === 'ENFORCE' && current.forceUpgradeOnSignin === true && min >= MIN_PASSWORD_LENGTH;
  if (!strong) {
    const target = Math.max(min, MIN_PASSWORD_LENGTH);
    const kept: StrengthOptions = { ...options, minPasswordLength: target };
    // A maximum below the new minimum would make every password fail; Google refuses that rule.
    if (typeof kept.maxPasswordLength === 'number' && kept.maxPasswordLength < target) delete kept.maxPasswordLength;
    body.passwordPolicyConfig = {
      passwordPolicyEnforcementState: 'ENFORCE',
      forceUpgradeOnSignin: true,
      passwordPolicyVersions: [{ customStrengthOptions: kept }],
    };
    updateMask.push('passwordPolicyConfig');
    changes.push(`password rule: ${describeRule(current)} -> at least ${target} characters, enforced, old passwords changed at next sign-in`);
  }

  if (record(fields.emailPrivacyConfig).enableImprovedEmailPrivacy !== true) {
    body.emailPrivacyConfig = { ...EMAIL_PRIVACY_CONFIG };
    updateMask.push('emailPrivacyConfig');
    changes.push('email enumeration protection: off -> on');
  }

  return changes.length === 0 ? null : { tenantId, displayName, changes, updateMask, body };
}

export type SecureDeps = {
  accessToken: () => Promise<string>;
  fetch: typeof fetch;
  log: (line: string) => void;
};

const API = 'https://identitytoolkit.googleapis.com/v2';

// Every tenant of the project, page by page. A failure names only the HTTP status.
async function listTenants(project: string, deps: SecureDeps, token: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let pageToken: string | null = null;
  do {
    const query = new URLSearchParams({ pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
    const response = await deps.fetch(`${API}/projects/${project}/tenants?${query}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': project },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`listing the tenants failed with status ${response.status}`);
    const page = record(await response.json());
    if (Array.isArray(page.tenants)) all.push(...(page.tenants as unknown[]));
    pageToken = typeof page.nextPageToken === 'string' && page.nextPageToken !== '' ? page.nextPageToken : null;
  } while (pageToken);
  return all;
}

export async function secureTenants(
  options: SecureOptions,
  deps: SecureDeps,
): Promise<{ checked: number; needed: number; changed: number }> {
  const token = await deps.accessToken();
  const listed = await listTenants(options.project, deps, token);
  const ids = (t: unknown) => /([^/]+)$/.exec(String(record(t).name))?.[1];
  for (const wanted of options.tenants) {
    if (!listed.some((t) => ids(t) === wanted)) throw new Error(`tenant ${wanted} was not found in project ${options.project}`);
  }
  const chosen = options.tenants.length === 0 ? listed : listed.filter((t) => options.tenants.includes(ids(t) ?? ''));

  // Every tenant is read and checked before anything is sent.
  const plan = chosen.map((tenant) => ({ tenant, change: tenantChange(tenant) }));
  const needed = plan.filter((entry) => entry.change !== null).length;
  let changed = 0;
  for (const { tenant, change } of plan) {
    if (!change) {
      const id = ids(tenant);
      const name = String(record(tenant).displayName ?? '');
      deps.log(`tenant ${id} (${name}): already set`);
      continue;
    }
    const label = `tenant ${change.tenantId} (${change.displayName})`;
    if (options.apply) {
      const mask = new URLSearchParams({ updateMask: change.updateMask.join(',') });
      const response = await deps.fetch(`${API}/projects/${options.project}/tenants/${change.tenantId}?${mask}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Goog-User-Project': options.project },
        body: JSON.stringify(change.body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`changing tenant ${change.tenantId} failed with status ${response.status}`);
      let kept: TenantChange | null;
      try {
        kept = tenantChange(await response.json());
      } catch {
        kept = change;
      }
      if (kept !== null) throw new Error(`tenant ${change.tenantId} did not keep the new settings`);
      changed++;
    }
    for (const line of change.changes) deps.log(`${label}: ${options.apply ? 'changed' : 'would change'} ${line}`);
  }
  deps.log(
    options.apply
      ? `changed ${changed} of ${chosen.length} tenants.`
      : `dry run: ${needed} of ${chosen.length} tenants would change; nothing was changed. Run again with --apply to change them.`,
  );
  return { checked: chosen.length, needed, changed };
}

async function main() {
  const options = parseSecureArgs(process.argv.slice(2));
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  await secureTenants(options, {
    accessToken: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error('no Google credentials: run gcloud auth application-default login');
      return token;
    },
    fetch,
    log: (line) => console.log(line),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'checking the tenants failed');
    process.exit(1);
  });
}
