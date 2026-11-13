// Plan-check cases for a RE-APPLY: the owner's saved plan of a root that is already applied
// (infra/dryscope/scripts/check-plan.js). Existing resources show as no-op, the provider reports
// some IAM member fields as full resource paths, and a few resource types may change in place;
// every first-apply rule and every refusal of a delete or replacement still stands.
// Also covers the lifecycle ignore_changes entries a release depends on (check-guards.js).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'infra', 'dryscope', 'scripts', 'check-plan.js');
const { checkPlan } = require(SCRIPT);
const { checkConfig, REQUIRED_IGNORED } = require(
  path.join(ROOT, 'infra', 'dryscope', 'scripts', 'check-guards.js'),
);

const load = (root, environment) =>
  JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'infra', 'dryscope', 'fixtures', `${root}-${environment}.plan.json`),
      'utf8',
    ),
  ).resource_changes;

const find = (plan, address) => plan.find((rc) => rc.address === address);
const check = (plan, root, environment, options = {}) =>
  checkPlan(plan, { root, environment, ...options });

// What `terraform show -json` prints for a root that is applied and unchanged: every resource is a
// no-op, and the IAM members the provider reads back carry full resource paths.
const SERVICE_PATH = (n) => `projects/dryscope/locations/us-central1/services/${n}`;
const JOB_PATH = (n) => `projects/dryscope/locations/us-central1/jobs/${n}`;
function applied(root, environment) {
  const plan = structuredClone(load(root, environment));
  for (const rc of plan) {
    rc.change.actions = ['no-op'];
    rc.change.before = structuredClone(rc.change.after);
    const after = rc.change.after;
    if (rc.type === 'google_cloud_run_v2_service_iam_member') after.name = SERVICE_PATH(after.name);
    if (rc.type === 'google_cloud_run_v2_job_iam_member') after.name = JOB_PATH(after.name);
  }
  return plan;
}
const update = (rc, edit) => {
  rc.change.actions = ['update'];
  edit(rc.change.after);
};

describe.each([
  ['app', 'test'],
  ['app', 'live'],
  ['data', 'test'],
  ['data', 'live'],
])('%s root, %s: a plan of the applied root', (root, environment) => {
  test('every resource unchanged, with IAM names as full resource paths, passes', () => {
    expect(check(applied(root, environment), root, environment)).toEqual([]);
  });

  test('a wrong full path for an IAM name is still refused', () => {
    const plan = applied(root, environment);
    const rc = plan.find((r) => /^google_cloud_run_v2_(service|job)_iam_member$/.test(r.type));
    if (!rc) return; // the data root has none
    rc.change.after.name = rc.change.after.name.replace('dryscope/', 'elsewhere/');
    expect(check(plan, root, environment)).toHaveLength(1);
  });

  test('a delete or a replacement is refused even in a re-apply', () => {
    for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
      const plan = applied(root, environment);
      plan[0].change.actions = actions;
      const problems = check(plan, root, environment);
      expect(problems.some((p) => p.includes('delete or replace'))).toBe(true);
    }
  });

  test('a resource outside the table is still refused', () => {
    const plan = applied(root, environment);
    plan.push({
      address: 'google_storage_bucket.extra',
      type: 'google_storage_bucket',
      change: { actions: ['no-op'], after: { project: 'dryscope' } },
    });
    expect(check(plan, root, environment)).toEqual([
      'google_storage_bucket.extra: not in the expected ' + root + ' inventory',
    ]);
  });
});

describe('app root, test: in-place changes in a re-apply', () => {
  const environment = 'test';
  const JOB = 'google_cloud_scheduler_job.jobs["access-projection"]';
  const ROLE = 'google_project_iam_custom_role.deploy';
  const REFUSED = 'plan would change it in place; a first apply only creates';
  const SERVICE = 'google_cloud_run_v2_service.svc["api"]';

  test('an allowed type may change in place when the new state still matches the table', () => {
    const plan = applied('app', environment);
    update(find(plan, JOB), (after) => {
      after.description = 'a new description';
    });
    update(find(plan, 'google_monitoring_alert_policy.api_latency'), (after) => {
      after.display_name = 'renamed';
    });
    expect(check(plan, 'app', environment)).toEqual([]);
  });

  test('the new state is held to the table: a changed schedule target is refused', () => {
    const plan = applied('app', environment);
    update(find(plan, JOB), (after) => {
      after.http_target[0].uri = 'https://example.invalid/api/internal/access-projection';
    });
    const problems = check(plan, 'app', environment);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('http_target.0.uri');
  });

  test('a custom role (its permission list is IAM) may not change in place', () => {
    const plan = applied('app', environment);
    update(find(plan, ROLE), (after) => {
      after.permissions = [...after.permissions, 'run.services.delete'];
    });
    const problems = check(plan, 'app', environment);
    expect(problems[0]).toBe(`${ROLE}: ${REFUSED}`);
    expect(problems).toHaveLength(2); // and the wider list is refused too
  });

  test.each([
    'google_cloud_run_v2_service_iam_member.public["api"]',
    'google_cloud_run_v2_job_iam_member.deploy',
  ])('an in-place change to an IAM grant (%s) is refused', (address) => {
    const plan = applied('app', environment);
    const rc = find(plan, address);
    if (!rc) return;
    update(rc, () => {});
    expect(check(plan, 'app', environment)).toEqual([`${rc.address}: ${REFUSED}`]);
  });

  test('a Cloud Run service may change in place only by the named exception', () => {
    const plan = applied('app', environment);
    update(find(plan, SERVICE), (after) => {
      after.template[0].max_instance_request_concurrency = 999;
    });
    expect(check(plan, 'app', environment)).toEqual([`${SERVICE}: ${REFUSED}`]);
  });

  test('clearing the release revision name, so Cloud Run makes a fresh revision, passes', () => {
    const plan = applied('app', environment);
    const rc = find(plan, SERVICE);
    rc.change.before.template[0].revision = 'dryscope-api-test-00012-abc';
    rc.change.actions = ['update'];
    expect(check(plan, 'app', environment)).toEqual([]);
  });

  test.each([
    ['keeps', 'dryscope-api-test-00012-abc'],
    ['renames', 'dryscope-api-test-terraform'],
  ])('an update that %s the release revision name is refused', (_, name) => {
    const plan = applied('app', environment);
    const rc = find(plan, SERVICE);
    rc.change.before.template[0].revision = 'dryscope-api-test-00012-abc';
    update(rc, (after) => (after.template[0].revision = name));
    expect(check(plan, 'app', environment)).toEqual([`${SERVICE}: ${REFUSED}`]);
  });

  test('a plan with no existing resource is a first apply: every update is refused', () => {
    const plan = load('app', environment);
    update(find(plan, JOB), () => {});
    expect(check(plan, 'app', environment)).toEqual([
      `${JOB}: plan would change it in place; a first apply only creates`,
    ]);
  });

  test('a plan of only updates is not a re-apply', () => {
    const plan = load('app', environment);
    for (const rc of plan) rc.change.actions = ['update'];
    expect(check(plan, 'app', environment).length).toBeGreaterThan(0);
  });

  test('the command line accepts the re-apply plan and says so', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reapply-'));
    try {
      const file = path.join(dir, 'plan.json');
      fs.writeFileSync(file, JSON.stringify({ resource_changes: applied('app', environment) }));
      const run = spawnSync('node', [SCRIPT, 'app', environment, file], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('re-apply plan');
      expect(run.stdout).toContain('0 problem(s)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('app root: what a release sets is ignored by the next apply', () => {
  const real = path.join(ROOT, 'infra', 'dryscope', 'app');
  const without = (entry) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ignore-'));
    for (const f of fs.readdirSync(real).filter((n) => n.endsWith('.tf'))) {
      const text = fs.readFileSync(path.join(real, f), 'utf8');
      fs.writeFileSync(
        path.join(dir, f),
        text
          .split('\n')
          .filter((line) => line.trim() !== `${entry},`)
          .join('\n'),
      );
    }
    return dir;
  };

  test('the real configuration ignores the image and traffic', () => {
    expect(checkConfig(real, 'app')).toEqual([]);
    expect(REQUIRED_IGNORED.app['google_cloud_run_v2_service.svc']).toEqual([
      'template[0].containers[0].image',
      'traffic',
    ]);
  });

  test.each([
    ['template[0].containers[0].image', 'google_cloud_run_v2_service.svc'],
    ['traffic', 'google_cloud_run_v2_service.svc'],
    ['template[0].template[0].containers[0].image', 'google_cloud_run_v2_job.migrate'],
  ])('removing %s from ignore_changes is named', (entry, resource) => {
    const dir = without(entry);
    try {
      expect(checkConfig(dir, 'app')).toEqual([
        expect.stringContaining(`${resource}: lifecycle.ignore_changes must name ${entry}`),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
