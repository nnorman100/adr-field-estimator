// Releases web/firestore.rules to the TEST field database (dryscope-field-test) through the
// Firebase Rules REST API, as the release workflow's deploy account (role dryscopeRulesReleaseTest,
// infra/dryscope/data/identities.tf). It reads release cloud.firestore/dryscope-field-test and its
// ruleset first: an unchanged file creates nothing. Otherwise it creates a ruleset from the file (a
// rules error refuses it and changes nothing), points the release at it (creating the release the
// first time), then reads the release and its ruleset back and fails unless they hold exactly the
// committed file. Rules take a few minutes to reach every client.
//
//   gcloud auth print-access-token | node scripts/release-rules.ts --env test --file firestore.rules
//
// The access token comes on stdin, never in an argument or setting. Test only: the release name is
// derived from --env, and live is refused until the test-to-live release exists. It needs no
// installed packages (plain Node with type stripping), deletes nothing and prints only release and
// ruleset names, HTTP statuses and the API's error messages.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const API = 'https://firebaserules.googleapis.com/v1';
const PROJECT = 'dryscope';

export type RulesOptions = {
  env: 'test';
  source: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type RulesResult = { changed: boolean; release: string; ruleset: string };

export const releaseName = (env: 'test') =>
  `projects/${PROJECT}/releases/cloud.firestore/dryscope-field-${env}`;

const RULESET = new RegExp(`^projects/${PROJECT}/rulesets/[A-Za-z0-9-]+$`);

export function parseArgs(argv: string[]): { env: 'test'; file: string } {
  const value = (name: string): string => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v || v.startsWith('--')) throw new Error(`--${name} is required`);
    return v;
  };
  if (value('env') !== 'test')
    throw new Error('--env must be test (live rules releases are not built yet)');
  return { env: 'test', file: value('file') };
}

async function problem(what: string, res: Response): Promise<Error> {
  let message = '';
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') message = `: ${body.error.message.slice(0, 500)}`;
  } catch {
    // No JSON body; the status is enough.
  }
  return new Error(`${what}: status ${res.status}${message}`);
}

export async function releaseRules(
  options: RulesOptions,
  log: (line: string) => void = () => {},
): Promise<RulesResult> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!/^[\x21-\x7e]+$/.test(options.token)) throw new Error('no access token on stdin');
  if (options.source.trim() === '') throw new Error('the rules file is empty');
  const release = releaseName(options.env);
  const call = (method: string, name: string, body?: unknown) =>
    doFetch(`${API}/${name}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  // What the database enforces now, if anything.
  let current: string | null = null;
  const read = await call('GET', release);
  if (read.status === 200) {
    const name = ((await read.json()) as { rulesetName?: unknown }).rulesetName;
    if (typeof name !== 'string' || !RULESET.test(name))
      throw new Error(`reading ${release}: no ruleset name`);
    current = name;
    if (await holds(call, current, options.source)) {
      log(`unchanged: ${release} already enforces ${current}`);
      return { changed: false, release, ruleset: current };
    }
  } else if (read.status !== 404) {
    throw await problem(`reading ${release}`, read);
  }

  // A rules error refuses the ruleset here, before anything the database enforces changes.
  const created = await call('POST', `projects/${PROJECT}/rulesets`, {
    source: { files: [{ name: 'firestore.rules', content: options.source }] },
  });
  if (created.status !== 200) throw await problem('creating the ruleset', created);
  const ruleset = ((await created.json()) as { name?: unknown }).name;
  if (typeof ruleset !== 'string' || !RULESET.test(ruleset))
    throw new Error('creating the ruleset: no ruleset name');
  log(`created ${ruleset}`);

  const moved =
    current === null
      ? await call('POST', `projects/${PROJECT}/releases`, { name: release, rulesetName: ruleset })
      : await call('PATCH', release, {
          release: { name: release, rulesetName: ruleset },
          updateMask: 'rulesetName',
        });
  if (moved.status !== 200)
    throw await problem(`${current === null ? 'creating' : 'updating'} ${release}`, moved);

  // Read what the database now enforces back, fresh, and require the committed file.
  const after = await call('GET', release);
  if (after.status !== 200) throw await problem(`reading ${release} back`, after);
  if (((await after.json()) as { rulesetName?: unknown }).rulesetName !== ruleset) {
    throw new Error(`${release} does not name ${ruleset} after the release`);
  }
  if (!(await holds(call, ruleset, options.source))) {
    throw new Error(`${ruleset} does not hold the committed rules file`);
  }
  log(
    `released ${ruleset} to ${release}${current === null ? ' (first release)' : `, was ${current}`}`,
  );
  return { changed: true, release, ruleset };
}

// Whether a ruleset's source is exactly the one committed file.
async function holds(
  call: (method: string, name: string) => Promise<Response>,
  ruleset: string,
  source: string,
): Promise<boolean> {
  const res = await call('GET', ruleset);
  if (res.status !== 200) throw await problem(`reading ${ruleset}`, res);
  const files =
    ((await res.json()) as { source?: { files?: Array<{ content?: unknown }> } }).source?.files ??
    [];
  return files.length === 1 && files[0]?.content === source;
}

async function main() {
  const { env, file } = parseArgs(process.argv.slice(2));
  const token = readFileSync(0, 'utf8').trim();
  await releaseRules({ env, source: readFileSync(file, 'utf8'), token }, (line) =>
    console.log(line),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'rules release failed');
    process.exit(1);
  });
}
