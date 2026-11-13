// Release smoke check for one staged revision of the rebuilt app in the TEST environment. The
// release workflow runs it against the revision's own tagged URL while the revision has 0% of
// traffic, and the image job in the Web app workflow runs it against a local container. Traffic
// moves only if it passes.
//
//   node scripts/smoke-release.ts --url <base URL> --commit <40-character commit> --version <YYYY.MM.DD-N> --env test
//
// Health must report the commit and the release version the image was built with (TC-8). Against
// Cloud Run, health must also report database ok, which the app says only after its own database
// login worked; the local container in the Web app workflow has no database, so localhost is exempt.
//
// Test only: its signed-out probes include a POST, so it must never run against live. Live checks
// arrive with the test-to-live release and must be read-only. It needs no installed packages (plain
// Node with type stripping), sends no credentials and prints only status codes and the health
// fields it checks.
import { pathToFileURL } from 'node:url';

export type SmokeOptions = {
  baseUrl: string;
  commit: string;
  version: string;
  env: 'test';
  requireDatabase: boolean;
  fetch?: typeof fetch;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
};

// Business routes a signed-out caller must never reach. Until sign-in exists every /api route
// outside the public list refuses (src/proxy.ts); once real routes land they stay on this list.
export const signedOutProbes: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'GET', path: '/api/jobs/current' }, // not a job id, so no route takes it
  { method: 'POST', path: '/api/companies' },
];

const REFUSED = new Set([401, 403]);

export function parseArgs(argv: string[]): SmokeOptions {
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
  const commit = value('commit');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit must be a 40-character commit hash');
  const version = value('version');
  if (!/^\d{4}\.\d{2}\.\d{2}-[1-9]\d{0,5}$/.test(version)) throw new Error('--version must be YYYY.MM.DD-N');
  if (value('env') !== 'test') throw new Error('--env must be test (live checks are not built yet)');
  return { baseUrl, commit, version, env: 'test', requireDatabase: !local };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns one line per failed check; an empty list means the revision may take traffic.
export async function runSmoke(options: SmokeOptions, log: (line: string) => void = () => {}) {
  const doFetch = options.fetch ?? fetch;
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 15000;
  const failures: string[] = [];
  const call = (method: string, path: string, body?: string) =>
    doFetch(`${options.baseUrl}${path}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
    });

  // A new revision can answer slowly on its first request, so health gets a few tries.
  let health: unknown = null;
  let lastProblem = 'no answer';
  for (let attempt = 1; attempt <= attempts && health === null; attempt++) {
    try {
      const res = await call('GET', '/api/health');
      if (res.status === 200) health = await res.json();
      else lastProblem = `status ${res.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.name : 'request failed';
    }
    if (health === null && attempt < attempts) await sleep(delayMs);
  }
  if (health === null) {
    failures.push(`health: ${lastProblem} after ${attempts} tries`);
  } else {
    const h = health as Record<string, unknown>;
    if (h.status !== 'ok') failures.push(`health: status is ${String(h.status)}, expected ok`);
    if (h.env !== options.env) failures.push(`health: env is ${String(h.env)}, expected ${options.env}`);
    if (h.commit !== options.commit) {
      failures.push(`health: commit is ${String(h.commit)}, expected ${options.commit}`);
    }
    if (h.version !== options.version) {
      failures.push(`health: version is ${String(h.version)}, expected ${options.version}`);
    }
    if (options.requireDatabase && h.database !== 'ok') {
      failures.push(`health: database is ${String(h.database)}, expected ok`);
    }
    log(
      `health: status=${String(h.status)} env=${String(h.env)} commit=${String(h.commit)} version=${String(h.version)} database=${String(h.database)}`,
    );
  }

  for (const probe of signedOutProbes) {
    try {
      const res = await call(probe.method, probe.path, probe.method === 'POST' ? '{}' : undefined);
      log(`signed out ${probe.method} ${probe.path}: ${res.status}`);
      if (!REFUSED.has(res.status)) {
        failures.push(`signed out ${probe.method} ${probe.path}: ${res.status}, expected 401 or 403`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'request failed';
      failures.push(`signed out ${probe.method} ${probe.path}: ${reason}`);
    }
  }
  return failures;
}

async function main() {
  const failures = await runSmoke(parseArgs(process.argv.slice(2)), (line) => console.log(line));
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log('smoke: passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'smoke check failed');
    process.exit(1);
  });
}
