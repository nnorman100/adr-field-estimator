// The restore and rollback drill kit (docs/plans/S8/S8-5.md): infra/dryscope/scripts/restore-drill.sh,
// run with recording stubs for every program that could reach Google Cloud. The script is
// owner-run; these prove what it would run without running any of it. The full runs answer the
// script from fixtures (a fake gcloud, Auth Proxy, psql and curl) and assert on the recorded calls.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, Shell, shlex, splitlines } from './workflow_support.ts';

const SCRIPT = path.join(ROOT, 'infra/dryscope/scripts/restore-drill.sh');
const FIXTURES = path.join(ROOT, 'infra/dryscope/fixtures');
const CLOUD = ['gcloud', 'cloud-sql-proxy', 'psql', 'curl'];

const shells: Shell[] = [];
const trees: string[] = [];
afterEach(() => {
  for (const s of shells.splice(0)) rmSync(s.tmp, { recursive: true, force: true });
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

function shell() {
  const s = new Shell();
  shells.push(s);
  return s;
}

// Shell.run with a longer limit: a full run of the script starts some hundred short processes,
// which on the shared build host can take longer than Shell.run's 30 seconds.
function runLong(
  s: Shell,
  script: string,
  env: Record<string, string>,
  interpreter = ['bash', '--noprofile', '--norc', '-eo', 'pipefail'],
) {
  const [program, ...args] = interpreter;
  const result = spawnSync(program, [...args, '-c', script], {
    env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.tmp, ...env },
    cwd: s.tmp,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Every program fails unless a body says otherwise.
function drill(
  args: string,
  stdin = '',
  bodies: Record<string, string> = {},
  env: Record<string, string> = {},
  script = SCRIPT,
) {
  const s = shell();
  for (const program of [...CLOUD, 'jq']) s.fake(program, bodies[program] ?? 'exit 1');
  for (const [program, body] of Object.entries(bodies))
    if (!CLOUD.includes(program)) s.fake(program, body);
  const result = runLong(s, `bash ${JSON.stringify(script)} ${args} <<'EOF'\n${stdin}\nEOF`, env);
  return { s, result };
}

const PIT = '--point-in-time 2026-11-18T15:04:00Z';
const LOST_ARGS = `--env live --recovery --lost-instance ${PIT}`;
const MODES = {
  drill: '--env test --domain example.test --zone us-central1-b',
  'damaged rows': `--env live --recovery ${PIT}`,
  'lost instance': `--env live --recovery --lost-instance ${PIT} --zone us-central1-b --domain example.test`,
  salvage: '--env live --recovery --salvage',
};

// The commands a dry run prints, one "+ " line each, split back into their arguments.
function printed(args: string): string[][] {
  const { result } = drill(`${args} --dry-run`);
  expect(result.status, result.stderr).toBe(0);
  return splitlines(result.stdout)
    .filter((line) => line.startsWith('+ '))
    .map((line) => shlex(line.slice(2)));
}

// Your own account reaches only copies; the web app's own account (impersonated) may also read
// the original, which it already serves.
function proxyTarget(cmd: string[], instance = 'dryscope-(test|live)-pg') {
  const app = cmd.some((a) => a.startsWith('--impersonate-service-account='));
  return new RegExp(`^dryscope:[a-z0-9-]+:${instance}${app ? '(-|$)' : '-'}`);
}

// Every recorded call, all programs, in the order made: [program, ...arguments].
function ordered(s: Shell): string[][] {
  if (!existsSync(s.log)) return [];
  return splitlines(readFileSync(s.log, 'utf8')).map((line) => line.split('\x1f'));
}

// Removing the temporary database user the run itself added for your account is the revoke the
// run owes, not a delete of a recovery resource; it is checked on its own (grantsRevoked).
const isRevoke = (cmd: string[]) => cmd.includes('users') && cmd.includes('delete');
const isDelete = (cmd: string[]) =>
  !isRevoke(cmd) &&
  (cmd.includes('delete') || cmd.includes('rm') || cmd.includes('--no-deletion-protection'));

// Every database user the run added for your account is removed again, on the same instance,
// after it was added.
function grantsRevoked(commands: string[][]) {
  const created = commands.flatMap((c, i) =>
    c.includes('users') && c.includes('create')
      ? [{ i, at: c.find((a) => a.startsWith('--instance='))! }]
      : [],
  );
  for (const grant of created)
    expect(
      commands.findIndex((c, i) => i > grant.i && isRevoke(c) && c.includes(grant.at)),
      `no revoke of ${grant.at}`,
    ).toBeGreaterThan(grant.i);
  return created.length;
}

// A recorded call has no program name; put it back for the same checks.
const isDeleteCall = (args: string[]) => isDelete(['gcloud', ...args]);

function deleteTargets(cmd: string[]): string[] {
  if (cmd.includes('storage'))
    return cmd.filter((a) => a.startsWith('gs://')).map((a) => a.split('#')[0]);
  if (cmd.includes('firestore'))
    return cmd.filter((a) => a.startsWith('--database=')).map((a) => a.slice(11));
  return [cmd[cmd.indexOf('instances') + 2]];
}

// What `terraform plan` evaluated for the committed fixtures (scripts/check.sh keeps them current).
function planned(file: string) {
  const plan = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8'));
  return (address: string) =>
    plan.resource_changes.find((r: any) => r.address === address).change.after;
}

function names(env: 'test' | 'live') {
  const data = planned(`data-${env}.plan.json`);
  const app = planned(`app-${env}.plan.json`);
  const instance = data('google_sql_database_instance.main');
  const api = app('google_cloud_run_v2_service.svc["api"]');
  const account = (key: string) =>
    `${data(`google_service_account.runtime["${key}"]`).account_id}@${instance.project}`;
  return {
    project: instance.project,
    region: instance.region,
    instance: instance.name,
    database: data('google_sql_database.app').name,
    firestore: data('google_firestore_database.field').name,
    bucket: data('google_storage_bucket.evidence').name,
    service: api.name,
    connection: api.template[0].containers[0].env.find((e: any) => e.name === 'SQL_CONNECTION_NAME')
      .value,
    apiAccount: `${account('api')}.iam.gserviceaccount.com`,
    migrator: `${account('migrate')}.iam`,
  };
}

// Fixture answers for a full run. State lives in $HOME/state so tags and traffic move as the
// script moves them. Nothing here reaches the network.
const FAKE_GCLOUD = String.raw`st="$HOME/state"; mkdir -p "$st"
case "$1 $2 $3" in
  'config get-value account') echo owner@example.test; exit 0 ;;
  'auth print-access-token --project=dryscope')
    n=$(($(cat "$st/tokens" 2>/dev/null || echo 0) + 1)); echo "$n" > "$st/tokens"; echo "token-$n"; exit 0 ;;
  'sql instances describe')
    # A copy exists only once the run made it (or FAKE_EXISTING says it was there already).
    case "$4" in
      *-pg) [ -z "$FAKE_SOURCE_ZONE_FAILS" ] || exit 1; echo "$FAKE_SOURCE_ZONE" ;;
      *) [ -e "$st/made-$4" ] || [ -n "$FAKE_EXISTING" ] || exit 1; cat "$st/zone" 2>/dev/null || echo "$4" ;;
    esac; exit 0 ;;
  'sql instances get-latest-recovery-time') echo 2099-01-01T00:00:00Z; exit 0 ;;
  # As the Cloud SDK does, the user commands name the user in their messages.
  'sql users create') echo "Created user [$4]." >&2; [ -z "$FAKE_CREATE_FAILS" ] || exit 1; exit 0 ;;
  'sql users delete') echo "Deleted user [$4]." >&2; [ -z "$FAKE_REVOKE_FAILS" ] || exit 1; exit 0 ;;
  'sql instances clone')
    echo "$5" > "$st/copy"; touch "$st/made-$5"
    for a in "$@"; do case "$a" in --preferred-zone=*) echo "$a" | sed 's/^--preferred-zone=//' > "$st/zone" ;; esac; done
    echo operation-clone; exit 0 ;;
  'sql backups list')
    echo '[{"name":"projects/dryscope/backups/automated-us","type":"AUTOMATED","state":"SUCCESSFUL","location":"us","backupInterval":{"startTime":"2026-11-17T09:00:01.5Z"}},{"name":"projects/dryscope/backups/on-demand-us","type":"ON_DEMAND","state":"SUCCESSFUL","location":"us","backupInterval":{"startTime":"2026-11-17T20:00:00Z"}},{"name":"projects/dryscope/backups/automated-regional","type":"AUTOMATED","state":"SUCCESSFUL","location":"us-central1","backupInterval":{"startTime":"2026-11-17T21:00:00Z"}}]'
    exit 0 ;;
  'sql backups restore')
    for a in "$@"; do case "$a" in --restore-instance=*) touch "$st/made-$(echo "$a" | sed 's/^--restore-instance=//')" ;; esac; done
    echo operation-restore; exit 0 ;;
  'firestore backups list')
    echo '[{"name":"projects/dryscope/locations/us-central1/backups/field-1","database":"projects/dryscope/databases/'"$FAKE_FIRESTORE"'","state":"READY","snapshotTime":"2026-11-17T10:00:00Z"}]'
    exit 0 ;;
  'firestore databases restore') echo projects/dryscope/databases/restored/operations/op-1; exit 0 ;;
  'firestore operations describe')
    # Not done at the first look, then done (or failed).
    if [ -e "$st/op-seen" ]; then op="$FAKE_FS_OP"; [ -n "$op" ] || op='{"done":true}'; echo "$op"; else touch "$st/op-seen"; echo '{"done":false}'; fi
    exit 0 ;;
  'storage restore '*) touch "$st/restored"; exit 0 ;;
  'storage objects describe')
    case "$*" in
      *soft-drill*generation*) if [ -e "$st/restored" ] && [ -z "$FAKE_SAME_GENERATION" ]; then echo 1701; else echo 1700; fi ;;
      *generation*) echo 1700 ;; *) echo md5-1 ;;
    esac; exit 0 ;;
  'run services describe')
    case "$*" in
      *latestCreatedRevisionName*) echo rev-fresh ;;
      *) serving="$(cat "$st/serving" 2>/dev/null || echo rev-old)"; tag="$(cat "$st/tag" 2>/dev/null || echo rev-older)"
         echo '{"status":{"traffic":[{"revisionName":"'"$serving"'","percent":100},{"revisionName":"'"$tag"'","tag":"candidate","percent":0,"url":"https://candidate---svc.a.run.app"}]}}' ;;
    esac; exit 0 ;;
  'run services update-traffic')
    [ -z "$FAKE_TRAFFIC_STUCK" ] || exit 0
    for a in "$@"; do case "$a" in
      --update-tags=candidate=*) echo "$a" | sed 's/^--update-tags=candidate=//' > "$st/tag" ;;
      --to-revisions=*) echo "$a" | sed 's/^--to-revisions=//; s/=100$//' > "$st/serving" ;;
    esac; done; exit 0 ;;
  'run revisions describe')
    image=api@sha256:1
    if [ "$4" = rev-fresh ]; then conn="$FAKE_PROJECT_REGION:$(cat "$st/copy")"; [ -z "$FAKE_FRESH_IMAGE" ] || image="$FAKE_FRESH_IMAGE"; else conn="$FAKE_SOURCE_CONNECTION"; fi
    created="$FAKE_CREATED"; [ -n "$created" ] || created=2020-01-01T00:00:00Z
    echo '{"metadata":{"creationTimestamp":"'"$created"'"},"spec":{"containers":[{"image":"'"$image"'","env":[{"name":"SQL_CONNECTION_NAME","value":"'"$conn"'"}]}]}}'; exit 0 ;;
esac
exit 0`;

const FAKE_PROXY = String.raw`dir=""; for a in "$@"; do case "$a" in --unix-socket=*) dir="$(echo "$a" | sed 's/^--unix-socket=//')" ;; esac; conn="$a"; done
mkdir -p "$dir/$conn"
exec node -e "require('net').createServer().listen(process.argv[1])" "$dir/$conn/.s.PGSQL.5432"`;

const FAKE_PSQL = String.raw`u=""; prev=""; for a in "$@"; do [ "$prev" != -U ] || u="$a"; prev="$a"; done
echo "psql: note: connecting as user \"$u\"" >&2
# The app's login fails FAKE_LOGIN_FAILS times first, as while a new IAM grant is applying.
case "$*" in *'SELECT 1'*)
  n=$(($(cat "$HOME/logins" 2>/dev/null || echo 0) + 1)); echo "$n" > "$HOME/logins"
  [ "$n" -gt "$FAKE_LOGIN_FAILS" ] || exit 2
  echo 1; exit 0 ;; esac
case "$*" in *company=*) m="$FAKE_ORIGINAL_MARKERS"; [ -n "$m" ] || m='1|1'; echo "$m"; exit 0 ;; esac
# The checks and a short ledger are the copy's; the migrator's own read of the original is whole.
copy=1; case "$u" in dryscope-migrate-*) copy="" ;; esac
[ -z "$FAKE_CHECKS_FAIL" ] || [ -z "$copy" ] || exit 3
files="$(ls "$MIGRATIONS"/*.sql)"; [ -z "$FAKE_LEDGER_DROP_LAST" ] || [ -z "$copy" ] || files="$(echo "$files" | sed '$d')"
case "$*" in *-salvage-*) [ -z "$FAKE_SALVAGE_SHORT" ] || files="$(echo "$files" | sed '$d')" ;; esac
[ -z "$FAKE_LEDGER_RECENT" ] || [ -n "$copy" ] || echo "recent|$(basename "$(echo "$files" | tail -n 1)" .sql)"
for f in $files; do sum="$(sha256sum "$f" | cut -d' ' -f1)"; [ -z "$FAKE_LEDGER_BAD_SUM" ] || sum=bad; echo "ledger|$(basename "$f" .sql)|$sum"; done
case "$*" in *before=*) echo 'marker_before|1'; echo 'marker_after|0'; echo 'marker_company|c0000000-0000-4000-8000-000000000001' ;; esac
echo 'rows|companies|2'; echo 'rows|jobs|14'`;

const FAKE_CURL = String.raw`for a in "$@"; do :; done; url="$a"
case "$url" in
  */api/health) echo '{"status":"ok","env":"'"$FAKE_ENV"'","commit":"'"$FAKE_COMMIT"'","database":"ok"}' ;;
  https://run.googleapis.com/*)
    # Still for long by default; FAKE_CHANGED_AGO seconds ago for the first FAKE_CHANGED_READS reads.
    n=$(($(cat "$HOME/state/run-reads" 2>/dev/null || echo 0) + 1)); mkdir -p "$HOME/state"; echo "$n" > "$HOME/state/run-reads"
    at=2020-01-01T00:00:00.5Z; frac="$FAKE_CHANGED_FRACTION"; [ -n "$frac" ] || frac=123456
    [ "$n" -gt "$FAKE_CHANGED_READS" ] || at="$(date -u -d "@$(( $(date -u +%s) - FAKE_CHANGED_AGO ))" +%Y-%m-%dT%H:%M:%S).$frac"Z
    echo '{"updateTime":"'"$at"'"}' ;;
  */rooms\?*) v=1; case "$url" in *-drill/*) [ -z "$FAKE_ROOM_DRIFT" ] || v=2 ;; esac
    echo '{"documents":[{"name":"projects/dryscope/databases/x/documents/companies/c1/drafts/d1/rooms/r1","fields":{"moisture":{"integerValue":"'"$v"'"}}}]}' ;;
  */photos\?*) echo '{"documents":[{"name":"projects/dryscope/databases/x/documents/companies/c1/drafts/d1/photos/p1","fields":{"ref":{"stringValue":"evidence-1"}}}]}' ;;
  *) echo '{"name":"projects/dryscope/databases/x/documents/companies/c1/drafts/d1","fields":{"state":{"stringValue":"draft"}}}' ;;
esac`;

const HEAD = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const MARKERS = '11111111-1111-1111-1111-111111111111\n22222222-2222-2222-2222-222222222222';
const DRILL_ANSWERS = `test\ndone\n${MARKERS}\ndone\ncompanies/c1/drafts/d1\ndone\ndone\ndone`;
// The zone recovery's answers: go on, the admission applied, access on the copy reconciled.
const LOST = 'live\ndone\nreconciled';

const FAKES = {
  gcloud: FAKE_GCLOUD,
  'cloud-sql-proxy': FAKE_PROXY,
  psql: FAKE_PSQL,
  curl: FAKE_CURL,
  // Long waits (the drill's minute, the drain, polls) pass at once; the Auth Proxy's one-second
  // readiness polls wait briefly for real, so the fake proxy has time to open its socket.
  sleep: '[ "$1" != 1 ] || PATH="$REAL_PATH" exec sleep 0.2',
  jq: 'PATH="$REAL_PATH" exec jq "$@"',
};

function fakeEnv(env: 'test' | 'live', extra: Record<string, string> = {}) {
  const n = names(env);
  return {
    REAL_PATH: process.env.PATH ?? '',
    MIGRATIONS: path.join(ROOT, 'web/migrations'),
    FAKE_ENV: env,
    FAKE_SOURCE_ZONE: 'us-central1-a',
    FAKE_FIRESTORE: n.firestore,
    FAKE_PROJECT_REGION: `${n.project}:${n.region}`,
    FAKE_SOURCE_CONNECTION: n.connection,
    FAKE_COMMIT: HEAD,
    FAKE_CHANGED_READS: '0',
    FAKE_LOGIN_FAILS: '0',
    FAKE_CHANGED_AGO: '0',
    TF_VAR_api_image: 'api@sha256:1',
    TF_VAR_live_image: 'live@sha256:1',
    TF_VAR_alert_email: 'alerts@example.test',
    ...extra,
  };
}

// A run that is not a dry run, with every cloud program answering from the fixtures above.
function fullRun(args: string, stdin: string, extra: Record<string, string> = {}) {
  return drill(args, stdin, FAKES, fakeEnv(args.includes('--env live') ? 'live' : 'test', extra));
}

// One passing drill, run once and shared by the tests that read it: its result and every call.
let passingDrill:
  | { result: { status: number | null; stdout: string; stderr: string }; calls: string[][] }
  | undefined;
function okDrill() {
  if (!passingDrill) {
    const { s, result } = fullRun(MODES.drill, DRILL_ANSWERS);
    passingDrill = { result, calls: ordered(s) };
  }
  const { result, calls } = passingDrill;
  return {
    result,
    calls,
    of: (program: string) => calls.filter((c) => c[0] === program).map((c) => c.slice(1)),
  };
}

// The put-back the script printed after a failure, pasted as it is into a shell without -e.
function pastePutBack(stdout: string, extra: Record<string, string> = {}) {
  const lines = splitlines(stdout);
  const start = lines.findIndex((l) => l.startsWith('Put test back by hand'));
  expect(start).toBeGreaterThan(-1);
  const block = lines
    .slice(start + 1)
    .map((l) => l.slice(2))
    .join('\n');
  const owner = shell();
  for (const [program, body] of Object.entries(FAKES)) owner.fake(program, body);
  owner.fake('terraform', 'exit 0');
  owner.fake('node', 'exit 0');
  const pasted = runLong(owner, block, fakeEnv('test', extra), ['bash', '--noprofile', '--norc']);
  return { owner, pasted, block };
}

// Each test starts the script, and a full run starts some hundred short processes; on the shared
// build host a test with two full runs can take minutes.
describe('restore-drill.sh', { timeout: 300_000 }, () => {
  it.each(Object.entries(MODES))('makes no call in a dry run (%s)', (_mode, args) => {
    const { s, result } = drill(`${args} --dry-run`);
    expect(result.status, result.stderr).toBe(0);
    expect(s.calls()).toEqual([]);
    expect(result.stdout).toContain('result: pass');
    expect(result.stdout).toContain('dry run: yes');
  });

  it.each(Object.entries(MODES))('names its project in every cloud command (%s)', (_mode, args) => {
    const commands = printed(args);
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(CLOUD).toContain(cmd[0]);
      if (cmd[0] === 'gcloud')
        expect(cmd.filter((a) => a.startsWith('--project='))).toEqual(['--project=dryscope']);
      if (cmd[0] === 'cloud-sql-proxy') expect(cmd.at(-1)).toMatch(proxyTarget(cmd));
      const google = cmd.filter((a) => a.includes('googleapis.com'));
      for (const url of google) expect(url).toContain('/projects/dryscope/');
    }
  });

  it('deletes only the drill’s own resources, all named …-drill, and only after the put-back', () => {
    const commands = printed(MODES.drill);
    const deletes = commands.filter(isDelete);
    const targets = deletes.flatMap(deleteTargets);
    expect(targets.length).toBeGreaterThanOrEqual(7);
    for (const target of targets) expect(target).toMatch(/-drill$/);
    const instanceDeletes = deletes.filter((c) => c.includes('instances'));
    expect(instanceDeletes.map((c) => c[4])).toEqual([
      expect.stringMatching(/^dryscope-test-pg-\d{12}-drill$/),
      expect.stringMatching(/^dryscope-test-pg-\d{12}-drill$/),
      expect.stringMatching(/^dryscope-test-pg-salvage-\d{12}-drill$/),
      expect.stringMatching(/^dryscope-test-pg-salvage-\d{12}-drill$/),
    ]);
    const lastTraffic = commands.findLastIndex((c) => c.includes('update-traffic'));
    const firstInstanceDelete = commands.findIndex((c) => c.includes('instances') && isDelete(c));
    expect(firstInstanceDelete).toBeGreaterThan(lastTraffic);
  });

  it.each(Object.entries(MODES).filter(([mode]) => mode !== 'drill'))(
    'never deletes in an incident mode (%s)',
    (_mode, args) => {
      expect(printed(args).filter(isDelete)).toEqual([]);
    },
  );

  it.each([
    ['live without --recovery', '--env live --domain example.test --zone us-central1-b'],
    [
      'live --lost-instance without --recovery',
      `--env live --lost-instance ${PIT} --zone us-central1-b`,
    ],
    ['live --salvage without --recovery', '--env live --salvage'],
  ])('refuses %s, before any command', (_case, args) => {
    for (const dry of ['', ' --dry-run']) {
      const { s, result } = drill(args + dry, 'live');
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/--recovery/);
      expect(result.stdout).not.toMatch(/^\+ /m);
      expect(s.calls()).toEqual([]);
    }
  });

  it.each([
    ['the drill without --zone', '--env test --domain example.test', /--zone is required/],
    ['the drill without --domain', '--env test --zone us-central1-b', /--domain is required/],
    ['--lost-instance without --zone', `${LOST_ARGS} --domain example.test`, /--zone is required/],
    [
      '--lost-instance without --domain',
      `${LOST_ARGS} --zone us-central1-b`,
      /--domain is required/,
    ],
  ])('refuses %s, before any command', (_case, args, message) => {
    const { s, result } = drill(`${args} --dry-run`);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(s.calls()).toEqual([]);
  });

  it('runs the whole drill against the stubs: every call names its project, deletes only -drill names', () => {
    const run = okDrill();
    const { result } = run;
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('result: pass');
    expect(result.stdout + result.stderr).not.toContain('owner@example.test');
    const gcloud = run.of('gcloud');
    for (const call of gcloud)
      expect(call.filter((a) => a.startsWith('--project='))).toEqual(['--project=dryscope']);
    for (const call of run.of('cloud-sql-proxy'))
      expect(call.at(-1)).toMatch(proxyTarget(call, 'dryscope-test-pg'));
    for (const call of run.of('curl')) {
      const url = call.at(-1)!;
      if (url.includes('googleapis.com')) expect(url).toContain('/projects/dryscope/');
    }
    const clone = gcloud.find((c) => c[1] === 'instances' && c[2] === 'clone')!;
    const copy = clone[4];
    const restore = gcloud.find((c) => c[1] === 'backups' && c[2] === 'restore')!;
    const salvage = restore[4].slice('--restore-instance='.length);
    const stamp = copy.split('-')[3];
    const targets = gcloud.filter(isDeleteCall).flatMap((c) => deleteTargets(['gcloud', ...c]));
    expect(new Set(targets)).toEqual(
      new Set([
        copy,
        salvage,
        `dryscope-field-test-${stamp}-drill`,
        `gs://dryscope-evidence-test/drill/${stamp}-soft-drill`,
        `gs://dryscope-evidence-test/drill/${stamp}-version-drill`,
      ]),
    );
    for (const target of targets) expect(target).toMatch(/-drill$/);
    // Your account was added to the PITR copy and the salvage copy, and removed from both.
    expect(grantsRevoked(gcloud)).toBe(2);
    // The copy goes to the named zone, not the original's.
    expect(clone).toContain('--preferred-zone=us-central1-b');
    // Each tagged revision is checked at the load-balanced candidate host, never at run.app.
    const urls = run.of('curl').map((c) => c.at(-1)!);
    expect(urls.filter((u) => u.includes('run.app'))).toEqual([]);
    const candidate = 'https://candidate.test.example.test/api/health';
    expect(urls.filter((u) => u === candidate)).toHaveLength(2);
    // The draft's text reaches jq through private files, never its arguments.
    expect(run.of('jq').filter((c) => c.join(' ').includes('moisture'))).toEqual([]);
    // A soft-delete restore gives a new generation, recorded with the limit it means for the app.
    expect(result.stdout).toContain('soft delete: generation 1700 restored as 1701;');
    // The testers are asked to stop writing before the drill, and told when they may again.
    const out = result.stdout;
    expect(out.indexOf('stop writing there until this drill ends')).toBeGreaterThan(-1);
    expect(out.indexOf('stop writing there')).toBeLessThan(out.indexOf('== Phase 1'));
    expect(out.indexOf('may write there again')).toBeGreaterThan(out.indexOf('== Phase 8'));
  });

  it('never restores over an instance that already exists', () => {
    const { s, result } = fullRun(`--env live --recovery ${PIT}`, 'live', { FAKE_EXISTING: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/dryscope-live-pg-\d{12} already exists/);
    expect(s.calls('gcloud').filter((c) => c.includes('clone'))).toEqual([]);
    const salvage = fullRun('--env live --recovery --salvage', 'live', { FAKE_EXISTING: '1' });
    expect(salvage.result.status).toBe(1);
    expect(
      salvage.s.calls('gcloud').filter((c) => c[1] === 'backups' && c[2] === 'restore'),
    ).toEqual([]);
  });

  it('retries the app login while the new admission applies, and stops after 10 minutes', () => {
    const { s, result } = fullRun(MODES['lost instance'], LOST, { FAKE_LOGIN_FAILS: '2' });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(s.calls('psql').filter((c) => c.includes('SELECT 1'))).toHaveLength(3);
    expect(s.calls('sleep').filter((c) => c[0] === '30')).toHaveLength(2);
    const never = fullRun(MODES['lost instance'], LOST, { FAKE_LOGIN_FAILS: '99' });
    expect(never.result.status).toBe(1);
    expect(never.result.stderr).toContain('could not log in');
    expect(never.s.calls('psql').filter((c) => c.includes('SELECT 1'))).toHaveLength(20);
  });

  it.each([
    ['damaged rows', `--env live --recovery ${PIT}`, 'live'],
    ['lost instance', MODES['lost instance'], LOST],
    ['salvage', '--env live --recovery --salvage', 'live'],
  ])(
    'runs an incident mode against the stubs, deletes nothing and removes its access (%s)',
    (_mode, args, stdin) => {
      const { s, result } = fullRun(args, stdin);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('result: pass');
      expect(result.stdout + result.stderr).not.toContain('owner@example.test');
      const gcloud = s.calls('gcloud');
      expect(gcloud.length).toBeGreaterThan(0);
      for (const call of gcloud)
        expect(call.filter((a) => a.startsWith('--project='))).toEqual(['--project=dryscope']);
      expect(gcloud.filter(isDeleteCall)).toEqual([]);
      expect(grantsRevoked(gcloud)).toBe(1);
      expect(gcloud.filter((c) => c.includes('update-traffic'))).toEqual([]);
    },
  );

  it('restores the latest automated daily backup in us, not a later on-demand or regional one', () => {
    const { s, result } = fullRun('--env live --recovery --salvage', 'live');
    expect(result.status, result.stderr).toBe(0);
    const restore = s.calls('gcloud').find((c) => c[1] === 'backups' && c[2] === 'restore')!;
    expect(restore[3]).toBe('projects/dryscope/backups/automated-us');
  });

  it('refuses a zone recovery into the original’s own zone, before any copy', () => {
    const { s, result } = fullRun(
      `--env live --recovery --lost-instance ${PIT} --zone us-central1-a --domain example.test`,
      LOST,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--zone us-central1-a is the zone of dryscope-live-pg');
    expect(s.calls('gcloud').filter((c) => c.includes('clone'))).toEqual([]);
  });

  it('fails the field comparison when a room of the restored draft differs', () => {
    const { result } = fullRun(MODES.drill, DRILL_ANSWERS, { FAKE_ROOM_DRIFT: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the restored draft differs from the original');
    expect(result.stdout).toMatch(/phase 5 field database restore: \d+s fail/);
  });

  it('checks the copy as you, added to the copy only, through a proxy socket of its own', () => {
    const { s, result } = fullRun(`--env live --recovery ${PIT}`, 'live');
    expect(result.status, result.stderr).toBe(0);
    const copy = s.calls('gcloud').find((c) => c.includes('clone'))![4];
    expect(copy).toMatch(/^dryscope-live-pg-\d{12}$/);
    expect(s.calls('gcloud').filter((c) => c.includes('users') && c.includes('create'))).toEqual([
      [
        'sql',
        'users',
        'create',
        'owner@example.test',
        `--instance=${copy}`,
        '--type=cloud_iam_user',
        '--database-roles=dryscope-migrate-live@dryscope.iam',
        '--project=dryscope',
      ],
    ]);
    // Your own proxy is the one impersonating no one; your psql connects as you.
    const proxy = s.calls('cloud-sql-proxy').find((c) => !c.join(' ').includes('--impersonate'))!;
    const socket = proxy
      .find((a) => a.startsWith('--unix-socket='))!
      .slice('--unix-socket='.length);
    expect(socket).toMatch(/^\/tmp\/rd\.[A-Za-z0-9]{6}\/p\d$/);
    const psql = s.calls('psql').find((c) => c.includes('owner@example.test'))!;
    expect(psql[psql.indexOf('-h') + 1]).toBe(`${socket}/dryscope:us-central1:${copy}`);
  });

  it('stops an incident run at a time that is not recoverable yet, before any copy', () => {
    const { s, result } = drill(`--env live --recovery ${PIT}`, 'live', {
      gcloud: `case "$*" in *get-latest-recovery-time*) echo 2026-11-18T15:03:59.5Z ;; esac`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'the latest recoverable time of dryscope-live-pg is 2026-11-18T15:03:59.5Z',
    );
    expect(s.calls('gcloud').filter((c) => c.includes('clone'))).toEqual([]);
  });

  it('prints Terraform blocks that run as pasted and apply only when the plan check accepts', () => {
    // A copy of the script in its own tree, so the block's cd and outputs stay out of the repository.
    const tree = mkdtempSync(path.join(tmpdir(), 'restore-drill-'));
    trees.push(tree);
    const infra = path.join(tree, 'infra/dryscope');
    mkdirSync(path.join(infra, 'scripts'), { recursive: true });
    mkdirSync(path.join(infra, 'data/envs'), { recursive: true });
    const script = path.join(infra, 'scripts/restore-drill.sh');
    copyFileSync(SCRIPT, script);
    copyFileSync(
      path.join(path.dirname(SCRIPT), 'restore-drill-print.sh'),
      path.join(infra, 'scripts/restore-drill-print.sh'),
    );
    copyFileSync(
      path.join(ROOT, 'infra/dryscope/data/envs/test.tfvars'),
      path.join(infra, 'data/envs/test.tfvars'),
    );
    const { result } = drill(`${MODES.drill} --dry-run`, '', {}, {}, script);
    expect(result.status, result.stderr).toBe(0);
    const lines = splitlines(result.stdout);
    const start = lines.findIndex((l) =>
      l.includes('Owner step: apply the data root with the copy'),
    );
    const end = lines.indexOf('     (dry run: not waited for)', start);
    expect(start).toBeGreaterThan(-1);
    const block = lines
      .slice(start + 1, end)
      .map((l) => l.slice(5))
      .join('\n');
    const copy = /dryscope-test-pg-\d{12}-drill/.exec(block)![0];
    for (const [check, applied] of [
      ['exit 1', ['init', 'plan', 'show']],
      ['exit 0', ['init', 'plan', 'show', 'apply']],
    ] as const) {
      const owner = shell();
      owner.fake('terraform', 'exit 0');
      owner.fake('node', check);
      // Pasted as the owner would, unchanged, into a shell without -e.
      const pasted = owner.run(block, {}, owner.tmp, ['bash', '--noprofile', '--norc']);
      expect(pasted.status === 0).toBe(check === 'exit 0');
      expect(owner.calls('terraform').map((c) => c[0])).toEqual(applied);
      expect(owner.calls('terraform')[1]).toEqual([
        'plan',
        '-var-file=envs/test.tfvars',
        '-var',
        `sql_instance_override=${copy}`,
        '-out=test.tfplan',
      ]);
      expect(owner.calls('node')).toEqual([['../scripts/check-plan.js', 'data', 'test', '-']]);
      // The plan JSON can hold the alert address: it goes to the check through a pipe, never a file.
      expect(existsSync(path.join(infra, 'data/test.json'))).toBe(false);
    }
  });

  it('moves no traffic to a fresh revision running another image than the recorded one', () => {
    const { s, result } = fullRun(MODES.drill, DRILL_ANSWERS, { FAKE_FRESH_IMAGE: 'api@sha256:2' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'revision rev-fresh runs ["api@sha256:2"], not the recorded revision\'s ["api@sha256:1"]',
    );
    const traffic = s.calls('gcloud').filter((c) => c.includes('update-traffic'));
    expect(traffic.filter((c) => c.some((a) => a.includes('rev-fresh')))).toEqual([]);
    expect(result.stdout).toMatch(/phase 7 repoint on test, then put back: \d+s fail/);
    expect(result.stdout).toContain('Put test back by hand');
  });

  it('prints the recorded images for the lost-instance repoint to check', () => {
    const { result } = fullRun(MODES['lost instance'], LOST);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`jq -c '[.spec.containers[].image]')" = '["api@sha256:1"]' ]`);
  });

  it('waits for the field restore to finish, then reads it with a fresh token', () => {
    const { result, calls } = okDrill();
    expect(result.status, result.stderr).toBe(0);
    const done = calls.findLastIndex(
      (c) => c[0] === 'gcloud' && c[1] === 'firestore' && c[2] === 'operations',
    );
    const token = calls.findIndex((c, i) => i > done && c[2] === 'print-access-token');
    const read = calls.findIndex((c, i) => i > done && c[0] === 'curl');
    expect(token).toBeGreaterThan(done);
    expect(read).toBeGreaterThan(token);
    expect(calls[read].at(-1)).toMatch(
      /\/databases\/dryscope-field-test-\d{12}-drill\/documents\//,
    );
  });

  it('reports a failed field restore as a failed restore', () => {
    const { result } = fullRun(MODES.drill, DRILL_ANSWERS, {
      FAKE_FS_OP: '{"done":true,"error":{"code":9,"message":"backup unreadable"}}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /the restore into dryscope-field-test-\d{12}-drill failed: backup unreadable/,
    );
    expect(result.stdout).toMatch(/phase 5 field database restore: \d+s fail/);
  });

  it('refuses the same job as both markers', () => {
    const same = '11111111-1111-1111-1111-111111111111';
    const { s, result } = fullRun(MODES.drill, `test\ndone\n${same}\n${same}`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('the two markers must be two different jobs');
    expect(s.calls('gcloud').filter((c) => c.includes('clone'))).toEqual([]);
  });

  it('reads both markers on the original as the app’s account and fails when the second is not there', () => {
    const ok = okDrill();
    expect(ok.result.status, ok.result.stderr).toBe(0);
    const read = ok
      .of('psql')
      .find((c) => c.includes('company=c0000000-0000-4000-8000-000000000001'))!;
    expect(read[read.indexOf('-U') + 1]).toBe('dryscope-api-test@dryscope.iam');
    expect(read[read.indexOf('-h') + 1]).toMatch(/\/dryscope:us-central1:dryscope-test-pg$/);
    expect(read).toContain('after=22222222-2222-2222-2222-222222222222');
    const { result } = fullRun(MODES.drill, DRILL_ANSWERS, { FAKE_ORIGINAL_MARKERS: '1|0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the markers are not both on dryscope-test-pg');
    expect(result.stdout).toMatch(/phase 3 checks on the copy: \d+s fail/);
  });

  it('waits out the drain before staging, then repoints', () => {
    const { s, result } = fullRun(MODES.drill, DRILL_ANSWERS, {
      FAKE_CHANGED_READS: '1',
      FAKE_CHANGED_AGO: '60',
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const calls = ordered(s);
    const wait = calls.findIndex(
      (c) => c[0] === 'sleep' && Number(c[1]) >= 835 && Number(c[1]) <= 841,
    );
    const firstRead = calls.findIndex(
      (c) => c[0] === 'curl' && c.at(-1)!.startsWith('https://run.googleapis.com/'),
    );
    const firstMove = calls.findIndex((c) => c.includes('update-traffic'));
    expect(wait).toBeGreaterThan(firstRead);
    expect(firstMove).toBeGreaterThan(wait);
  });

  it('stages nothing while the service keeps changing, and prints the put-back', () => {
    const { s, result } = fullRun(MODES.drill, DRILL_ANSWERS, {
      FAKE_CHANGED_READS: '99',
      FAKE_CHANGED_AGO: '60',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dryscope-api-test keeps changing');
    expect(s.calls('gcloud').filter((c) => c.includes('update-traffic'))).toEqual([]);
    expect(result.stdout).toMatch(/phase 7 repoint on test, then put back: \d+s fail/);
    expect(grantsRevoked(s.calls('gcloud'))).toBe(2);
  });

  it('prints a put-back that runs as pasted and clears no override before the serving check passes', () => {
    const { result } = fullRun(MODES.drill, DRILL_ANSWERS, { FAKE_FRESH_IMAGE: 'api@sha256:2' });
    expect(result.status).toBe(1);
    const good = pastePutBack(result.stdout);
    expect(good.pasted.status, good.pasted.stderr).toBe(0);
    expect(good.owner.calls('terraform').map((c) => c[0])).toEqual([
      ...['init', 'plan', 'show', 'apply'],
      ...['init', 'plan', 'show', 'apply'],
    ]);
    for (const plan of good.owner.calls('terraform').filter((c) => c[0] === 'plan'))
      expect(plan).toContain('sql_instance_override=');
    const calls = ordered(good.owner);
    const lastMove = calls.findLastIndex((c) => c.includes('update-traffic'));
    const firstApply = calls.findIndex((c) => c[0] === 'terraform' && c[1] === 'apply');
    const servingCheck = calls.findLastIndex(
      (c, i) =>
        i < firstApply && c[0] === 'curl' && c.at(-1) === 'https://test.example.test/api/health',
    );
    expect(servingCheck).toBeGreaterThan(lastMove);
    // Traffic that does not move stops the chain before any apply.
    const stuck = pastePutBack(result.stdout, { FAKE_TRAFFIC_STUCK: '1' });
    expect(stuck.pasted.status).not.toBe(0);
    expect(stuck.owner.calls('terraform')).toEqual([]);
  });

  it('stops a zone recovery when the original’s zone cannot be read, with a result block', () => {
    const { s, result } = fullRun(MODES['lost instance'], LOST, {
      FAKE_SOURCE_ZONE_FAILS: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not read the zone of dryscope-live-pg');
    expect(s.calls('gcloud').filter((c) => c.includes('clone'))).toEqual([]);
    expect(result.stdout).toMatch(/phase 2 point-in-time copy .*: \d+s fail/);
    expect(result.stdout).toContain('result: fail');
  });

  it('prints the result block when a zone recovery stops at its repoint checks', () => {
    const { result } = fullRun(MODES['lost instance'], LOST, {
      FAKE_CREATED: '2099-01-01T00:00:00Z',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('so do not repoint');
    expect(result.stdout).toMatch(/phase 7 repoint checks: \d+s fail/);
    expect(result.stdout).toContain('result: fail');
  });

  const [SALVAGE, DAMAGED] = [MODES.salvage, MODES['damaged rows']];
  it.each([
    ['a salvage outside the US', `${SALVAGE} --salvage-region europe-west1`, /US region/],
    ['a salvage into the original region', `${SALVAGE} --salvage-region us-central1`, /US region/],
    ['--zone on a damaged-rows copy', `${DAMAGED} --zone us-central1-b`, /--zone is only for/],
    ['an incident mode on test', '--env test --recovery --salvage', /are for live/],
    ['--domain on a salvage', `${SALVAGE} --domain example.test`, /--domain is only for/],
    [
      '--salvage-region on a damaged-rows copy',
      `${DAMAGED} --salvage-region us-east4`,
      /--salvage-region is only for/,
    ],
  ])('refuses %s, before any command', (_case, args, message) => {
    const { s, result } = drill(`${args} --dry-run`);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(s.calls()).toEqual([]);
  });

  it('salvages into another US region when asked', () => {
    const commands = printed('--env live --recovery --salvage --salvage-region us-east4');
    expect(commands.find((c) => c.includes('restore'))).toContain('--region=us-east4');
  });

  it('fails a copy whose ledger checksum differs from the migration file', () => {
    const { result } = fullRun(`--env live --recovery ${PIT}`, 'live', {
      FAKE_LEDGER_BAD_SUM: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('(id and checksum) is not the first');
  });

  it('fails a zone-recovery copy that lacks a migration of the release serving at the restore point', () => {
    const { result } = fullRun(MODES['lost instance'], LOST, {
      FAKE_LEDGER_DROP_LAST: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `the migrations of the release serving at the restore point (commit ${HEAD})`,
    );
  });

  it('fails a damaged-rows copy whose ledger lacks a migration the original had applied by then', () => {
    const { s, result } = fullRun(`--env live --recovery ${PIT}`, 'live', {
      FAKE_LEDGER_DROP_LAST: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not the ledger of dryscope-live-pg at 2026-11-18T15:04');
    expect(result.stdout).not.toContain('Copy back only the damaged rows');
    // The expected ledger is the original's own, read as the migrator, up to the restore point.
    const read = s.calls('psql').find((c) => c.includes('pit=2026-11-18T15:04:00Z'))!;
    expect(read[read.indexOf('-U') + 1]).toBe('dryscope-migrate-live@dryscope.iam');
    expect(read[read.indexOf('-h') + 1]).toMatch(/\/dryscope:us-central1:dryscope-live-pg$/);
    const recent = { FAKE_LEDGER_DROP_LAST: '1', FAKE_LEDGER_RECENT: '1' };
    const inFlight = fullRun(`--env live --recovery ${PIT}`, 'live', recent).result;
    expect(inFlight.status).toBe(1);
    expect(inFlight.stderr).toContain('may still have been committing');
  });

  it('removes your temporary access when the checks fail', () => {
    const { s, result } = fullRun(`--env live --recovery ${PIT}`, 'live', {
      FAKE_CHECKS_FAIL: '1',
    });
    expect(result.status).not.toBe(0);
    expect(grantsRevoked(s.calls('gcloud'))).toBe(1);
    expect(result.stdout).toContain('result: fail');
  });

  it('fails the run, printing the removal to run by hand, when your temporary access cannot be removed', () => {
    const { s, result } = fullRun(`--env live --recovery ${PIT}`, 'live', {
      FAKE_REVOKE_FAILS: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /Remove your temporary access to dryscope-live-pg-\d{12} by hand now: gcloud sql users delete/,
    );
    expect(result.stdout).toContain('result: fail');
    expect(result.stdout).not.toContain('result: pass');
    expect(result.stdout).not.toContain('Copy back only the damaged rows');
    expect(result.stdout + result.stderr).not.toContain('owner@example.test');
    expect(s.calls('gcloud').filter(isRevoke)).toHaveLength(1);
  });

  it('removes no database user it did not create', () => {
    const { s, result } = fullRun(`--env live --recovery ${PIT}`, 'live', {
      FAKE_CREATE_FAILS: '1',
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('result: fail');
    expect(
      s.calls('gcloud').filter((c) => c.includes('users') && c.includes('create')),
    ).toHaveLength(1);
    expect(s.calls('gcloud').filter(isRevoke)).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain('owner@example.test');
    // A create whose outcome is unknown is reported, with the check to make.
    expect(result.stderr).toMatch(/access to dryscope-live-pg-\d{12} may have been created/);
  });

  it('counts a fraction of a second in the drain: a change 899.1 seconds ago still waits', () => {
    // The clock reads one fixed second, so the wait left is exactly 0.9 seconds.
    const { s, result } = drill(
      MODES.drill,
      DRILL_ANSWERS,
      {
        ...FAKES,
        date: '[ "$*" != "-u +%s" ] || { echo 1798000000; exit 0; }; PATH="$REAL_PATH" exec date "$@"',
      },
      fakeEnv('test', {
        FAKE_CHANGED_READS: '1',
        FAKE_CHANGED_AGO: '900',
        FAKE_CHANGED_FRACTION: '9',
      }),
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const calls = ordered(s);
    const firstRead = calls.findIndex(
      (c) => c[0] === 'curl' && c.at(-1)!.startsWith('https://run.googleapis.com/'),
    );
    const firstMove = calls.findIndex((c) => c.includes('update-traffic'));
    const waits = calls.filter((c, i) => i > firstRead && i < firstMove && c[0] === 'sleep');
    expect(waits).toEqual([['sleep', '1']]);
  });

  it('prints copy-back reads that lift forced row-level security and temporary access that ends', () => {
    const { result } = fullRun(`--env live --recovery ${PIT}`, 'live');
    expect(result.status, result.stderr).toBe(0);
    const text = result.stdout.slice(result.stdout.indexOf('Copy back only the damaged rows'));
    expect(text.match(/ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;/g)).toHaveLength(3);
    expect(text).toMatch(/gcloud sql users create "\$ME" --instance=dryscope-live-pg-\d{12} /);
    expect(text).toMatch(/gcloud sql users delete "\$ME" --instance=dryscope-live-pg-\d{12} /);
    expect(text).toContain(
      '--impersonate-service-account=dryscope-migrate-live@dryscope.iam.gserviceaccount.com',
    );
    // Every read and write by the full primary key, never id alone; a write only while the
    // whole row is as compared.
    expect(text).not.toMatch(/WHERE <primary key> /);
    expect(text.match(/WHERE \(<primary key columns>\) IN /g)).toHaveLength(2);
    expect(text).toContain('WHERE (<primary key columns>) = (<the row');
    expect(text).toContain(
      'AND (<every column>) IS NOT DISTINCT FROM (<the whole row as read in step 2>);',
    );
    // Each proxy in a fresh private directory, stopped by its own process id, then removed.
    expect(text).not.toContain('kill %');
    expect(text.match(/="\$\(mktemp -d \/tmp\/rd\.XXXXXX\)"/g)).toHaveLength(2);
    expect(text).toContain('kill "$P"; rm -rf "$D";');
    expect(text).toContain('kill "$Q"; rm -rf "$S"');
    // A row of a job is written only with its job locked, unsigned, unsubmitted and as compared,
    // and its revision advanced, in the same transaction.
    const write = text.slice(text.indexOf('  4.'), text.indexOf('  5.'));
    expect(write).toMatch(
      /UPDATE jobs SET revision = revision \+ 1, .*\n.*status NOT IN \('submitted', 'signed'\)\n.*AND revision = <its revision as read in step 2>;/,
    );
    expect(write.indexOf('UPDATE jobs')).toBeLessThan(write.indexOf('UPDATE <table>'));
    const read = text.slice(text.indexOf('  2.'), text.indexOf('  3.'));
    expect(read).toMatch(/jobs NO FORCE ROW LEVEL SECURITY;\n.*SELECT status, revision FROM jobs/);
    expect(text.match(/psql -X -v HISTFILE=\/dev\/null /g)).toHaveLength(2);
    expect(text).toContain('[ "$C" = 1 ] && gcloud sql users delete "$ME"');
    // Only the proxy is backgrounded, so S stays set; jobs is locked before the row's table.
    expect(text).toMatch(/S="\$\(mktemp -d \/tmp\/rd\.XXXXXX\)"\n\s+cloud-sql-proxy/);
    const [jobs, row] = ['ALTER TABLE jobs NO FORCE', 'ALTER TABLE <table> NO FORCE'];
    expect(write.indexOf(jobs)).toBeLessThan(write.indexOf(row));
    expect(read.indexOf(jobs)).toBeLessThan(read.indexOf(row));
  });

  it('prints a zone recovery’s repoint only after access on the copy is reconciled', () => {
    const { result } = fullRun(MODES['lost instance'], LOST);
    expect(result.status, result.stderr).toBe(0);
    const out = result.stdout;
    expect(out).toMatch(/re-apply every access change made after[\s\S]*Repoint the app/);
    expect(out).toContain('A session revoked in the sign-in tenant is no substitute');
    expect(out).toMatch(
      /a company suspended \(companies.status\)[\s\S]*This\nlist is kept by hand/,
    );
    const refused = fullRun(MODES['lost instance'], 'live\ndone\nnot yet');
    expect(refused.result.status).toBe(1);
    expect(refused.result.stderr).toContain('is not reconciled with the changes made after');
    expect(refused.result.stdout).not.toContain('Repoint the app');
    expect(refused.result.stdout).toContain('result: fail');
  });

  it('accepts a salvage copy whose daily backup predates the serving release’s last migration', () => {
    const { result } = fullRun(MODES.drill, DRILL_ANSWERS, { FAKE_SALVAGE_SHORT: '1' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails the soft-delete restore when the restored object kept its old generation', () => {
    const { result } = fullRun(MODES.drill, DRILL_ANSWERS, { FAKE_SAME_GENERATION: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('kept generation 1700: expected a new one');
    expect(result.stdout).toMatch(/phase 6 evidence files.*: \d+s fail/);
  });

  it.each(['test', 'live'] as const)('uses the names the Terraform plans evaluate (%s)', (env) => {
    const n = names(env);
    const commands = printed(env === 'test' ? MODES.drill : MODES['lost instance']);
    const gcloud = commands.filter((c) => c[0] === 'gcloud');
    const clone = gcloud.find((c) => c[2] === 'instances' && c[3] === 'clone')!;
    expect(clone[4]).toBe(n.instance);
    expect(clone).toContain(`--project=${n.project}`);
    // The salvage copy is in another region; every copy is named after the original.
    for (const proxy of commands.filter((c) => c[0] === 'cloud-sql-proxy'))
      expect(proxy.at(-1)).toMatch(proxyTarget(proxy, n.instance));
    const [checks, login] = commands.filter((c) => c[0] === 'psql');
    expect(checks).toContain(`migrator=${n.migrator}`);
    expect(checks[checks.indexOf('-d') + 1]).toBe(n.database);
    expect(login[login.indexOf('-d') + 1]).toBe(n.database);
    const impersonating = commands.find(
      (c) => c[0] === 'cloud-sql-proxy' && c.some((a) => a.startsWith('--impersonate')),
    );
    expect(impersonating).toContain(`--impersonate-service-account=${n.apiAccount}`);
    for (const run of gcloud.filter((c) => c[1] === 'run' && c[2] === 'services'))
      expect(run[4]).toBe(n.service);
    if (env === 'test') {
      const restore = gcloud.find((c) => c[1] === 'firestore' && c[3] === 'restore')!;
      expect(restore.find((a) => a.startsWith('--destination-database='))).toMatch(
        new RegExp(`^--destination-database=${n.firestore}-`),
      );
      const reads = commands.filter(
        (c) => c[0] === 'curl' && c.at(-1)!.includes('firestore.googleapis.com'),
      );
      expect(reads.some((c) => c.at(-1)!.includes(`/databases/${n.firestore}/documents/`))).toBe(
        true,
      );
      const objects = gcloud.flatMap((c) => c.filter((a) => a.startsWith('gs://')));
      expect(objects.length).toBeGreaterThan(0);
      for (const object of objects) expect(object.startsWith(`gs://${n.bucket}/drill/`)).toBe(true);
    }
  });
});
