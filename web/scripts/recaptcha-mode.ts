// Owner-run command (TC-6): set sign-in reCAPTCHA on one existing sign-in tenant, to audit or off.
// Sign-in reCAPTCHA is Identity Platform's bot protection for email and password sign-in,
// sign-up, email-link sign-in and password reset. Audit mode assesses each attempt and blocks
// none; the verdicts show in Cloud Monitoring (`identitytoolkit.googleapis.com/recaptcha/...`).
// New tenants already get audit mode from `npm run platform:create-tenant`. Enforcement waits for
// TC-13, so `--mode enforce` is refused. Like the tenant command it runs with the person's own
// Google credentials (`gcloud auth application-default login`), never the app's, which cannot
// change tenant settings (AGENTS.md rule 2: Firebase Auth settings are the owner's).
//
//   npm run platform:recaptcha -- --project dryscope --tenant <tenant id> --mode audit
//   npm run platform:recaptcha -- --project dryscope --tenant <tenant id> --mode off
//
// Only the reCAPTCHA state for email and password is sent, with an update mask naming only it, so
// the score rules, the keys Identity Platform provisions and every other setting stay as they are.
// The answer is checked. Prints only the tenant id and the mode, never a token, a key or Google's
// answer (docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects.tenants/patch).
import { pathToFileURL } from 'node:url';
import { PROJECT_ID } from './create-tenant';

export type RecaptchaMode = 'AUDIT' | 'OFF';
export type RecaptchaOptions = { project: string; tenant: string; mode: RecaptchaMode };

// The id part of a tenant's resource name, as the tenant command reads it back.
const TENANT_ID = /^[A-Za-z0-9-]{1,128}$/;
const ENFORCE_REFUSED = '--mode enforce is refused until TC-13 (enforcement comes after the first test users)';
const MODES: Record<string, RecaptchaMode> = { audit: 'AUDIT', off: 'OFF' };

export function parseRecaptchaArgs(argv: string[]): RecaptchaOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--project' || arg === '--tenant' || arg === '--mode') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (Object.hasOwn(values, arg)) throw new Error(`${arg} is given twice`);
      values[arg] = value;
      i++;
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else throw new Error(`unexpected argument ${arg}`);
  }
  const project = values['--project'];
  if (!project) throw new Error('--project is required');
  if (!PROJECT_ID.test(project)) throw new Error('--project must be a Google Cloud project id');
  const tenant = values['--tenant'];
  if (!tenant) throw new Error('--tenant is required');
  if (!TENANT_ID.test(tenant)) throw new Error('--tenant must be a tenant id: letters, digits and hyphens');
  const given = values['--mode'];
  if (!given) throw new Error('--mode is required');
  if (given.toLowerCase() === 'enforce') throw new Error(ENFORCE_REFUSED);
  const mode = Object.hasOwn(MODES, given) ? MODES[given] : undefined;
  if (!mode) throw new Error('--mode must be audit or off');
  return { project, tenant, mode };
}

export type RecaptchaDeps = {
  accessToken: () => Promise<string>;
  fetch: typeof fetch;
  log: (line: string) => void;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export async function setRecaptchaMode(options: RecaptchaOptions, deps: RecaptchaDeps): Promise<void> {
  // Checked again here so no caller can send ENFORCE before TC-13.
  if (options.mode !== 'AUDIT' && options.mode !== 'OFF') throw new Error(ENFORCE_REFUSED);
  const shown = options.mode.toLowerCase();
  const mask = new URLSearchParams({ updateMask: 'recaptchaConfig.emailPasswordEnforcementState' });
  const url = `https://identitytoolkit.googleapis.com/v2/projects/${options.project}/tenants/${options.tenant}?${mask}`;
  const token = await deps.accessToken();
  const response = await deps.fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Goog-User-Project': options.project },
    body: JSON.stringify({ recaptchaConfig: { emailPasswordEnforcementState: options.mode } }),
    signal: AbortSignal.timeout(30_000),
  });
  // A failure names only the HTTP status, never the response text, which can echo request details.
  if (!response.ok) throw new Error(`setting reCAPTCHA on tenant ${options.tenant} failed with status ${response.status}`);
  let kept: unknown;
  try {
    kept = record(record(await response.json()).recaptchaConfig).emailPasswordEnforcementState;
  } catch {
    kept = undefined;
  }
  if (kept !== options.mode) throw new Error(`tenant ${options.tenant} did not keep reCAPTCHA mode ${shown}`);
  deps.log(`tenant ${options.tenant}: ${shown}`);
}

async function main() {
  const options = parseRecaptchaArgs(process.argv.slice(2));
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  await setRecaptchaMode(options, {
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
    console.error(error instanceof Error ? error.message : 'setting reCAPTCHA failed');
    process.exit(1);
  });
}
