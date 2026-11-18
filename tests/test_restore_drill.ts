// The restore and rollback drill kit (docs/plans/S8/S8-5.md): infra/dryscope/scripts/restore-drill.sh,
// run with recording stubs for every program that could reach Google Cloud. The script is
// owner-run; these prove what it would run without running any of it. The full runs answer the
// script from fixtures (a fake gcloud, Auth Proxy, psql and curl) and assert on the recorded calls.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const result = s.run(`bash ${JSON.stringify(script)} ${args} <<'EOF'\n${stdin}\nEOF`, env);
  return { s, result };
}

const PIT = '--point-in-time 2026-11-18T15:04:00Z';
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

const isDelete = (cmd: string[]) =>
  cmd.includes('delete') || cmd.includes('rm') || cmd.includes('--no-deletion-protection');

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
  'auth print-access-token --project=dryscope') echo token-1; exit 0 ;;
  'sql instances describe')
    case "$4" in *-pg) echo "$FAKE_SOURCE_ZONE" ;; *) cat "$st/zone" ;; esac; exit 0 ;;
  'sql instances get-latest-recovery-time') echo 2099-01-01T00:00:00Z; exit 0 ;;
  'sql instances clone')
    echo "$5" > "$st/copy"
    for a in "$@"; do case "$a" in --preferred-zone=*) echo "$a" | sed 's/^--preferred-zone=//' > "$st/zone" ;; esac; done
    echo operation-clone; exit 0 ;;
  'sql backups list')
    echo '[{"name":"projects/dryscope/backups/automated-us","type":"AUTOMATED","state":"SUCCESSFUL","location":"us","backupInterval":{"startTime":"2026-11-17T09:00:01.5Z"}},{"name":"projects/dryscope/backups/on-demand-us","type":"ON_DEMAND","state":"SUCCESSFUL","location":"us","backupInterval":{"startTime":"2026-11-17T20:00:00Z"}},{"name":"projects/dryscope/backups/automated-regional","type":"AUTOMATED","state":"SUCCESSFUL","location":"us-central1","backupInterval":{"startTime":"2026-11-17T21:00:00Z"}}]'
    exit 0 ;;
  'sql backups restore') echo operation-restore; exit 0 ;;
  'firestore backups list')
    echo '[{"name":"projects/dryscope/locations/us-central1/backups/field-1","database":"projects/dryscope/databases/'"$FAKE_FIRESTORE"'","state":"READY","snapshotTime":"2026-11-17T10:00:00Z"}]'
    exit 0 ;;
  'storage objects describe')
    case "$*" in *generation*) echo 1700 ;; *) echo md5-1 ;; esac; exit 0 ;;
  'run services describe')
    case "$*" in
      *latestCreatedRevisionName*) echo rev-fresh ;;
      *) serving="$(cat "$st/serving" 2>/dev/null || echo rev-old)"; tag="$(cat "$st/tag" 2>/dev/null || echo rev-older)"
         echo '{"status":{"traffic":[{"revisionName":"'"$serving"'","percent":100},{"revisionName":"'"$tag"'","tag":"candidate","percent":0}]}}' ;;
    esac; exit 0 ;;
  'run services update-traffic')
    for a in "$@"; do case "$a" in
      --update-tags=candidate=*) echo "$a" | sed 's/^--update-tags=candidate=//' > "$st/tag" ;;
      --to-revisions=*) echo "$a" | sed 's/^--to-revisions=//; s/=100$//' > "$st/serving" ;;
    esac; done; exit 0 ;;
  'run revisions describe')
    case "$*" in *creationTimestamp*) echo 2020-01-01T00:00:00Z; exit 0 ;; esac
    if [ "$4" = rev-fresh ]; then conn="$FAKE_PROJECT_REGION:$(cat "$st/copy")"; else conn="$FAKE_SOURCE_CONNECTION"; fi
    echo '{"spec":{"containers":[{"env":[{"name":"SQL_CONNECTION_NAME","value":"'"$conn"'"}]}]}}'; exit 0 ;;
esac
exit 0`;

const FAKE_PROXY = String.raw`dir=""; for a in "$@"; do case "$a" in --unix-socket=*) dir="$(echo "$a" | sed 's/^--unix-socket=//')" ;; esac; conn="$a"; done
mkdir -p "$dir/$conn"
exec node -e "require('net').createServer().listen(process.argv[1])" "$dir/$conn/.s.PGSQL.5432"`;

const FAKE_PSQL = String.raw`case "$*" in *'SELECT 1'*) echo 1; exit 0 ;; esac
for f in "$MIGRATIONS"/*.sql; do echo "ledger|$(basename "$f" .sql)"; done
case "$*" in *before=*) echo 'marker_before|1'; echo 'marker_after|0' ;; esac
echo 'rows|companies|2'; echo 'rows|jobs|14'`;

const FAKE_CURL = String.raw`for a in "$@"; do :; done; url="$a"
case "$url" in
  */api/health) echo '{"status":"ok","env":"'"$FAKE_ENV"'","database":"ok"}' ;;
  */rooms\?*) v=1; case "$url" in *-drill/*) [ -z "$FAKE_ROOM_DRIFT" ] || v=2 ;; esac
    echo '{"documents":[{"name":"projects/dryscope/databases/x/documents/companies/c1/drafts/d1/rooms/r1","fields":{"moisture":{"integerValue":"'"$v"'"}}}]}' ;;
  */photos\?*) echo '{"documents":[{"name":"projects/dryscope/databases/x/documents/companies/c1/drafts/d1/photos/p1","fields":{"ref":{"stringValue":"evidence-1"}}}]}' ;;
  *) echo '{"name":"projects/dryscope/databases/x/documents/companies/c1/drafts/d1","fields":{"state":{"stringValue":"draft"}}}' ;;
esac`;

const MARKERS = '11111111-1111-1111-1111-111111111111\n22222222-2222-2222-2222-222222222222';
const DRILL_ANSWERS = `test\n${MARKERS}\ndone\ncompanies/c1/drafts/d1\ndone\ndone\ndone`;

// A run that is not a dry run, with every cloud program answering from the fixtures above.
function fullRun(args: string, stdin: string, extra: Record<string, string> = {}) {
  const env = args.includes('--env live') ? 'live' : 'test';
  const n = names(env);
  return drill(
    args,
    stdin,
    {
      gcloud: FAKE_GCLOUD,
      'cloud-sql-proxy': FAKE_PROXY,
      psql: FAKE_PSQL,
      curl: FAKE_CURL,
      sleep: 'exit 0',
      jq: 'PATH="$REAL_PATH" exec jq "$@"',
    },
    {
      REAL_PATH: process.env.PATH ?? '',
      MIGRATIONS: path.join(ROOT, 'web/migrations'),
      FAKE_ENV: env,
      FAKE_SOURCE_ZONE: 'us-central1-a',
      FAKE_FIRESTORE: n.firestore,
      FAKE_PROJECT_REGION: `${n.project}:${n.region}`,
      FAKE_SOURCE_CONNECTION: n.connection,
      TF_VAR_api_image: 'api@sha256:1',
      TF_VAR_live_image: 'live@sha256:1',
      TF_VAR_alert_email: 'alerts@example.test',
      ...extra,
    },
  );
}

// Each test starts the script, and a full run starts some hundred short processes; on the shared
// build host that can take well over vitest's default five seconds.
describe('restore-drill.sh', { timeout: 60_000 }, () => {
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
      if (cmd[0] === 'cloud-sql-proxy')
        expect(cmd.at(-1)).toMatch(/^dryscope:[a-z0-9-]+:dryscope-(test|live)-pg-/);
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
      expect.stringMatching(/^dryscope-test-pg-\d{10}-drill$/),
      expect.stringMatching(/^dryscope-test-pg-\d{10}-drill$/),
      expect.stringMatching(/^dryscope-test-pg-salvage-\d{10}-drill$/),
      expect.stringMatching(/^dryscope-test-pg-salvage-\d{10}-drill$/),
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
    [
      '--lost-instance without --zone',
      `--env live --recovery --lost-instance ${PIT} --domain example.test`,
      /--zone is required/,
    ],
    [
      '--lost-instance without --domain',
      `--env live --recovery --lost-instance ${PIT} --zone us-central1-b`,
      /--domain is required/,
    ],
  ])('refuses %s, before any command', (_case, args, message) => {
    const { s, result } = drill(`${args} --dry-run`);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(s.calls()).toEqual([]);
  });

  it('runs the whole drill against the stubs: every call names its project, deletes only -drill names', () => {
    const { s, result } = fullRun(MODES.drill, DRILL_ANSWERS);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('result: pass');
    const gcloud = s.calls('gcloud');
    for (const call of gcloud)
      expect(call.filter((a) => a.startsWith('--project='))).toEqual(['--project=dryscope']);
    for (const call of s.calls('cloud-sql-proxy'))
      expect(call.at(-1)).toMatch(/^dryscope:[a-z0-9-]+:dryscope-test-pg-/);
    for (const call of s.calls('curl')) {
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
    // The copy goes to the named zone, not the original's.
    expect(clone).toContain('--preferred-zone=us-central1-b');
  });

  it.each([
    ['damaged rows', `--env test --recovery ${PIT}`, 'test'],
    [
      'lost instance',
      `--env test --recovery --lost-instance ${PIT} --zone us-central1-b --domain example.test`,
      'test\ndone',
    ],
    ['salvage', '--env test --recovery --salvage', 'test'],
  ])('runs an incident mode against the stubs and deletes nothing (%s)', (_mode, args, stdin) => {
    const { s, result } = fullRun(args, stdin);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('result: pass');
    const gcloud = s.calls('gcloud');
    expect(gcloud.length).toBeGreaterThan(0);
    for (const call of gcloud)
      expect(call.filter((a) => a.startsWith('--project='))).toEqual(['--project=dryscope']);
    expect(gcloud.filter(isDeleteCall)).toEqual([]);
    expect(gcloud.filter((c) => c.includes('update-traffic'))).toEqual([]);
  });

  it('restores the latest automated daily backup in us, not a later on-demand or regional one', () => {
    const { s, result } = fullRun('--env test --recovery --salvage', 'test');
    expect(result.status, result.stderr).toBe(0);
    const restore = s.calls('gcloud').find((c) => c[1] === 'backups' && c[2] === 'restore')!;
    expect(restore[3]).toBe('projects/dryscope/backups/automated-us');
  });

  it('refuses a zone recovery into the original’s own zone, before any copy', () => {
    const { s, result } = fullRun(
      `--env test --recovery --lost-instance ${PIT} --zone us-central1-a --domain example.test`,
      'test\ndone',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--zone us-central1-a is the zone of dryscope-test-pg');
    expect(s.calls('gcloud').filter((c) => c.includes('clone'))).toEqual([]);
  });

  it('fails the field comparison when a room of the restored draft differs', () => {
    const { result } = fullRun(MODES.drill, DRILL_ANSWERS, { FAKE_ROOM_DRIFT: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the restored draft differs from the original');
    expect(result.stdout).toMatch(/phase 5 field database restore: \d+s fail/);
  });

  it('checks the copy as you, added to the copy only, through a proxy socket of its own', () => {
    const { s, result } = fullRun(`--env test --recovery ${PIT}`, 'test');
    expect(result.status, result.stderr).toBe(0);
    const copy = s.calls('gcloud').find((c) => c.includes('clone'))![4];
    expect(copy).toMatch(/^dryscope-test-pg-\d{10}$/);
    expect(s.calls('gcloud').filter((c) => c.includes('users'))).toEqual([
      [
        'sql',
        'users',
        'create',
        'owner@example.test',
        `--instance=${copy}`,
        '--type=cloud_iam_user',
        '--database-roles=dryscope-migrate-test@dryscope.iam',
        '--project=dryscope',
      ],
    ]);
    const [proxy] = s.calls('cloud-sql-proxy');
    const socket = proxy
      .find((a) => a.startsWith('--unix-socket='))!
      .slice('--unix-socket='.length);
    expect(socket).toMatch(/^\/tmp\/rd\.[A-Za-z0-9]{6}\/p1$/);
    const [psql] = s.calls('psql');
    expect(psql[psql.indexOf('-h') + 1]).toBe(`${socket}/dryscope:us-central1:${copy}`);
  });

  it('stops an incident run at a time that is not recoverable yet, before any copy', () => {
    const { s, result } = drill(`--env test --recovery ${PIT}`, 'test', {
      gcloud: `case "$*" in *get-latest-recovery-time*) echo 2026-11-18T15:03:59.5Z ;; esac`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'the latest recoverable time of dryscope-test-pg is 2026-11-18T15:03:59.5Z',
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
    const copy = /dryscope-test-pg-\d{10}-drill/.exec(block)![0];
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
      expect(owner.calls('node')).toEqual([
        ['../scripts/check-plan.js', 'data', 'test', 'test.json'],
      ]);
    }
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
      expect(proxy.at(-1)).toMatch(new RegExp(`^${n.project}:[a-z0-9-]+:${n.instance}-`));
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
