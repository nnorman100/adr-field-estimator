// "A cannot read B" smoke check for the TEST environment (S3-17). Two fake test companies each have
// a signed-in test user; this calls the business routes with one company's sign-in and the other
// company's ids and expects a refusal every time, and that each sign-in is the one its company
// owns. It is read-only (GET only), uses only the fake data of the test companies, and sends no
// credential to a service that does not say it is the test environment.
//
//   ISOLATION_TOKEN_A=<ID token of company A's test user> ISOLATION_TOKEN_B=<... company B's> \
//     node scripts/smoke-isolation.ts --url <base URL> --company-a <uuid> --company-b <uuid>
//
// The tokens come from the environment, never from the command line, and are never printed. The
// owner supplies them from real test sign-ins (the S3-18 check) and the script is not run by the
// release workflow, which has no test sign-ins. It needs no installed packages (plain Node with
// type stripping) and prints only routes, with the other company's id as `{other}`, and status codes.
import { pathToFileURL } from 'node:url';

export type IsolationOptions = {
  baseUrl: string;
  companyA: string;
  companyB: string;
  tokenA: string;
  tokenB: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSED = new Set([401, 403, 404]);
// An id no company has, for routes that name a record rather than a company.
const NO_RECORD = '00000000-0000-4000-8000-000000000000';

// The reads one company's sign-in makes against the other company's ids. Every one is a GET.
export const probes: ReadonlyArray<{ path: (other: string) => string; label: string }> = [
  { label: '/api/companies/{other}/team', path: (other) => `/api/companies/${other}/team` },
  { label: '/api/platform/companies', path: () => '/api/platform/companies' },
  { label: '/api/platform/companies/{other}/team', path: (other) => `/api/platform/companies/${other}/team` },
  { label: '/api/invitations/{unknown}', path: () => `/api/invitations/${NO_RECORD}` },
];

export function parseIsolationArgs(argv: string[], env: Record<string, string | undefined>): IsolationOptions {
  const value = (name: string): string => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v || v.startsWith('--')) throw new Error(`--${name} is required`);
    return v;
  };
  const baseUrl = value('url').replace(/\/+$/, '');
  const url = new URL(baseUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('--url must be https (http only for localhost)');
  }
  const companyA = value('company-a').toLowerCase();
  const companyB = value('company-b').toLowerCase();
  if (!UUID.test(companyA) || !UUID.test(companyB)) throw new Error('--company-a and --company-b must be company ids');
  if (companyA === companyB) throw new Error('--company-a and --company-b must be different companies');
  const tokenA = env.ISOLATION_TOKEN_A;
  const tokenB = env.ISOLATION_TOKEN_B;
  if (!tokenA || !tokenB) throw new Error('ISOLATION_TOKEN_A and ISOLATION_TOKEN_B are required in the environment');
  return { baseUrl, companyA, companyB, tokenA, tokenB };
}

// One line per failed check; an empty list means neither company could reach the other.
export async function runIsolationSmoke(options: IsolationOptions, log: (line: string) => void = () => {}) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  const failures: string[] = [];
  const get = (path: string, token?: string) =>
    doFetch(`${options.baseUrl}${path}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  // No sign-in goes anywhere that does not say it is the test environment.
  try {
    const res = await get('/api/health');
    const health = res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null;
    if (!health || health.env !== 'test') {
      return [`health: the service did not report the test environment (status ${res.status}); no sign-in was sent`];
    }
  } catch (error) {
    return [`health: ${error instanceof Error ? error.name : 'request failed'}; no sign-in was sent`];
  }

  const sides = [
    { name: 'A', own: options.companyA, other: options.companyB, token: options.tokenA },
    { name: 'B', own: options.companyB, other: options.companyA, token: options.tokenB },
  ];
  for (const side of sides) {
    // The control: the sign-in works and is this company's, so a refusal below is not a dead token.
    try {
      const res = await get('/api/me', side.token);
      const body = res.status === 200 ? ((await res.json()) as { company?: { id?: string } }) : null;
      log(`${side.name} /api/me: ${res.status}`);
      if (res.status !== 200) failures.push(`${side.name} /api/me: ${res.status}, expected 200 for its own sign-in`);
      else if (body?.company?.id?.toLowerCase() !== side.own) failures.push(`${side.name} /api/me: names another company`);
    } catch (error) {
      failures.push(`${side.name} /api/me: ${error instanceof Error ? error.name : 'request failed'}`);
    }
    for (const probe of probes) {
      try {
        const res = await get(probe.path(side.other), side.token);
        const text = await res.text();
        log(`${side.name} ${probe.label}: ${res.status}`);
        if (!REFUSED.has(res.status)) failures.push(`${side.name} ${probe.label}: ${res.status}, expected 401, 403 or 404`);
        else if (text.toLowerCase().includes(side.other)) failures.push(`${side.name} ${probe.label}: the answer names the other company`);
      } catch (error) {
        failures.push(`${side.name} ${probe.label}: ${error instanceof Error ? error.name : 'request failed'}`);
      }
    }
  }
  return failures;
}

async function main() {
  const failures = await runIsolationSmoke(parseIsolationArgs(process.argv.slice(2), process.env), (line) => console.log(line));
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log('isolation smoke: passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'isolation smoke check failed');
    process.exit(1);
  });
}
