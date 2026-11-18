// The restore and rollback drill kit (docs/plans/S8/S8-5.md): infra/dryscope/scripts/restore-drill.sh,
// run with recording stubs for every program that could reach Google Cloud. The script is
// owner-run; these prove what it would run without running any of it.
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, Shell, shlex, splitlines } from './workflow_support.ts';

const SCRIPT = path.join(ROOT, 'infra/dryscope/scripts/restore-drill.sh');
const NAMING = path.join(ROOT, 'infra/dryscope/modules/naming/main.tf');
const PROGRAMS = ['gcloud', 'cloud-sql-proxy', 'psql', 'curl', 'jq'];

const shells: Shell[] = [];
afterEach(() => {
  for (const s of shells.splice(0)) rmSync(s.tmp, { recursive: true, force: true });
});

function drill(args: string, stdin = '') {
  const s = new Shell();
  shells.push(s);
  for (const program of PROGRAMS) s.fake(program, 'exit 1');
  const result = s.run(`bash ${JSON.stringify(SCRIPT)} ${args} <<'EOF'\n${stdin}\nEOF`);
  return { s, result };
}

const PIT = '--point-in-time 2026-11-18T15:04:00Z';
const MODES = {
  drill: '--env test --domain example.test',
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

function deleteTargets(cmd: string[]): string[] {
  if (cmd.includes('storage'))
    return cmd.filter((a) => a.startsWith('gs://')).map((a) => a.split('#')[0]);
  if (cmd.includes('firestore'))
    return cmd.filter((a) => a.startsWith('--database=')).map((a) => a.slice(11));
  return [cmd[cmd.indexOf('instances') + 2]];
}

describe('restore-drill.sh', () => {
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
      expect(['gcloud', 'cloud-sql-proxy', 'psql', 'curl']).toContain(cmd[0]);
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
    ['live without --recovery', '--env live --domain example.test'],
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

  it.each(['test', 'live'])('uses the naming module’s names (%s)', (env) => {
    const tf = readFileSync(NAMING, 'utf8');
    const tfvars = readFileSync(path.join(ROOT, `infra/dryscope/data/envs/${env}.tfvars`), 'utf8');
    const project = /^project_id\s*=\s*"([^"]+)"/m.exec(tfvars)![1];
    const resolve = (text: string) =>
      text.replaceAll('${local.env}', env).replaceAll('${var.project_id}', project);
    const output = (name: string) => {
      const block = new RegExp(`output "${name}" \\{[\\s\\S]*?\\n\\}`).exec(tf)![0];
      return resolve(/value\s*=\s*"([^"]+)"/.exec(block)![1]);
    };
    const mapEntry = (block: string, key: string) =>
      resolve(new RegExp(`\\b${key}\\s*=\\s*"([^"]+)"`).exec(block)![1]);
    const services = /output "cloud_run_service_names" \{[\s\S]*?\n\}/.exec(tf)![0];
    const accounts = /sa_ids = \{[\s\S]*?\n {2}\}/.exec(tf)![0];

    const { s, result } = drill(`--env ${env} --print-names`);
    expect(result.status, result.stderr).toBe(0);
    expect(s.calls()).toEqual([]);
    const names = Object.fromEntries(splitlines(result.stdout).map((line) => line.split('=', 2)));

    expect(names).toMatchObject({
      project,
      sql_instance_name: output('sql_instance_name'),
      sql_connection_name: output('sql_connection_name'),
      sql_database_name: output('sql_database_name'),
      firestore_database_id: output('firestore_database_id'),
      evidence_bucket: output('evidence_bucket'),
      api_service: mapEntry(services, 'api'),
      api_service_account: `${mapEntry(accounts, 'api')}@${project}.iam.gserviceaccount.com`,
      migrate_service_account: `${mapEntry(accounts, 'migrate')}@${project}.iam.gserviceaccount.com`,
    });
    // S8-6 admits a recovered instance only as dryscope-<env>-pg- and a suffix.
    expect(names.sql_copy.startsWith(`${names.sql_instance_name}-`)).toBe(true);
    expect(names.sql_salvage_copy.startsWith(`${names.sql_instance_name}-`)).toBe(true);
    expect(names.firestore_copy.startsWith(`${names.firestore_database_id}-`)).toBe(true);
  });
});
