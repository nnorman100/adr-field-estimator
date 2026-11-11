// Plan-check cases for two test-release follow-ups:
//   - the Cloud Scheduler job that calls the web app's internal access-projection route
//     (infra/dryscope/app/scheduler.tf) as the scheduler account the data root creates, and
//   - the deploy account's Firebase Rules role, which the test release workflow uses to release
//     web/firestore.rules to the field database (infra/dryscope/data/identities.tf).
// Fixtures and the checker are the ones tests/test_terraform_plan_check.js uses.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'infra', 'dryscope', 'scripts', 'check-plan.js');
const { checkPlan, expectedPlan } = require(SCRIPT);

function load(root, environment) {
  const file = path.join(ROOT, 'infra', 'dryscope', 'fixtures', `${root}-${environment}.plan.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).resource_changes;
}

const find = (plan, address) => plan.find((rc) => rc.address === address);
const account = (name) => `${name}@dryscope.iam.gserviceaccount.com`;
const grant = (address, after) => ({
  address,
  type: address.split('.')[0],
  change: { actions: ['create'], after },
});

describe.each(['test', 'live'])('app root, %s: the access-projection schedule', (environment) => {
  const JOB = 'google_cloud_scheduler_job.jobs["access-projection"]';
  const other = environment === 'test' ? 'live' : 'test';
  const plan = () => load('app', environment);
  const edit = (fn) => {
    const changed = plan();
    fn(find(changed, JOB).change.after);
    return checkPlan(changed, { root: 'app', environment });
  };
  const target = (after) => after.http_target[0];

  test('calls the route as the scheduler account with the audience the route checks', () => {
    const after = find(plan(), JOB).change.after;
    expect(after.name).toBe(`dryscope-access-projection-${environment}`);
    expect(after.region).toBe('us-central1');
    expect(after.paused).toBe(false);
    expect(target(after)).toMatchObject({
      http_method: 'POST',
      uri: `https://dryscope-api-${environment}-570228742694.us-central1.run.app/api/internal/access-projection`,
      oidc_token: [
        {
          service_account_email: account(`dryscope-scheduler-${environment}`),
          audience: `dryscope-${environment}-access-projection`,
        },
      ],
    });
    expect(checkPlan(plan(), { root: 'app', environment })).toEqual([]);
  });

  test.each([
    ['the other environment’s', `dryscope-${other}-access-projection`],
    ['another job’s', `dryscope-${environment}-other-job`],
    ['the URL as', `https://dryscope-api-${environment}-570228742694.us-central1.run.app`],
  ])('%s audience is refused', (_label, audience) => {
    const problems = edit((after) => {
      target(after).oidc_token[0].audience = audience;
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('audience');
  });

  test.each([
    `dryscope-scheduler-${other}`,
    `dryscope-api-${environment}`,
    `dryscope-deploy-${environment}`,
  ])('a token for %s is refused', (name) => {
    const problems = edit((after) => {
      target(after).oidc_token[0].service_account_email = account(name);
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('service_account_email');
  });

  test.each([
    [
      'the other environment’s web app',
      `https://dryscope-api-${other}-570228742694.us-central1.run.app/api/internal/access-projection`,
    ],
    [
      'another route',
      `https://dryscope-api-${environment}-570228742694.us-central1.run.app/api/jobs`,
    ],
    ['another host', 'https://example.invalid/api/internal/access-projection'],
  ])('a call to %s is refused', (_label, uri) => {
    const problems = edit((after) => {
      target(after).uri = uri;
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('uri');
  });

  test('a GET, a paused job or another schedule is refused', () => {
    expect(edit((after) => (target(after).http_method = 'GET'))).toHaveLength(1);
    expect(edit((after) => (after.paused = true))).toHaveLength(1);
    expect(edit((after) => (after.schedule = '0 * * * *'))).toHaveLength(1);
  });

  test('an OAuth token, headers, a body or a Pub/Sub target are refused', () => {
    const oauth = edit((after) => {
      target(after).oauth_token = [
        { service_account_email: account(`dryscope-scheduler-${environment}`) },
      ];
    });
    expect(oauth).toEqual([`${JOB}: http_target.0.oauth_token must be empty`]);
    expect(edit((after) => (target(after).headers = { Authorization: 'Bearer x' }))).toHaveLength(
      1,
    );
    expect(edit((after) => (target(after).body = 'e30='))).toHaveLength(1);
    expect(
      edit((after) => (after.pubsub_target = [{ topic_name: 'projects/dryscope/topics/x' }])),
    ).toHaveLength(1);
  });

  test('a second schedule nobody listed is refused', () => {
    const changed = plan();
    const copy = structuredClone(find(changed, JOB));
    copy.address = 'google_cloud_scheduler_job.jobs["other"]';
    copy.change.after.name = `dryscope-other-${environment}`;
    changed.push(copy);
    const problems = checkPlan(changed, { root: 'app', environment });
    expect(problems).toEqual([
      'google_cloud_scheduler_job.jobs["other"]: not in the expected app inventory',
    ]);
  });

  test('an invoker grant for the scheduler account is refused (the service is already public)', () => {
    const changed = plan();
    changed.push(
      grant('google_cloud_run_v2_service_iam_member.scheduler', {
        project: 'dryscope',
        location: 'us-central1',
        name: `dryscope-api-${environment}`,
        role: 'roles/run.invoker',
        member: `serviceAccount:${account(`dryscope-scheduler-${environment}`)}`,
      }),
    );
    const problems = checkPlan(changed, { root: 'app', environment });
    expect(problems).toEqual([
      'google_cloud_run_v2_service_iam_member.scheduler: not in the expected app inventory',
    ]);
  });
});

describe.each(['test', 'live'])(
  'data root, %s: scheduler account and rules release',
  (environment) => {
    const ROLE = 'google_project_iam_custom_role.rules_release';
    const GRANT = 'google_project_iam_member.deploy_rules_release';
    const plan = () => load('data', environment);
    const edit = (address, fn) => {
      const changed = plan();
      fn(find(changed, address).change.after);
      return checkPlan(changed, { root: 'data', environment });
    };

    test('the scheduler account exists and is named for this environment', () => {
      const want = expectedPlan('data', environment);
      expect(want.others).toContain('google_service_account.scheduler');
      expect(want.others).toContain('google_project_service.apis["cloudscheduler.googleapis.com"]');
      expect(find(plan(), 'google_service_account.scheduler').change.after.account_id).toBe(
        `dryscope-scheduler-${environment}`,
      );
      const other = environment === 'test' ? 'live' : 'test';
      expect(
        edit('google_service_account.scheduler', (after) => {
          after.account_id = `dryscope-scheduler-${other}`;
        }),
      ).toHaveLength(1);
    });

    test('no grant in the table names the scheduler account', () => {
      const members = Object.values(expectedPlan('data', environment).grants).map((g) =>
        String(g.member),
      );
      expect(members.some((m) => m.includes('dryscope-scheduler-'))).toBe(false);
      const changed = plan();
      changed.push(
        grant('google_project_iam_member.scheduler_invoker', {
          project: 'dryscope',
          role: 'roles/run.invoker',
          member: `serviceAccount:${account(`dryscope-scheduler-${environment}`)}`,
        }),
      );
      expect(checkPlan(changed, { root: 'data', environment })).toEqual([
        'google_project_iam_member.scheduler_invoker: not in the expected data inventory',
      ]);
    });

    test('the rules role reads, creates and points releases only', () => {
      expect(find(plan(), ROLE).change.after).toMatchObject({
        role_id: `dryscopeRulesRelease${environment === 'test' ? 'Test' : 'Live'}`,
        permissions: [
          'firebaserules.releases.create',
          'firebaserules.releases.get',
          'firebaserules.releases.update',
          'firebaserules.rulesets.create',
          'firebaserules.rulesets.get',
        ],
      });
      expect(find(plan(), GRANT).change.after).toMatchObject({
        role: `projects/dryscope/roles/dryscopeRulesRelease${environment === 'test' ? 'Test' : 'Live'}`,
        member: `serviceAccount:${account(`dryscope-deploy-${environment}`)}`,
      });
    });

    test.each([
      'firebaserules.releases.delete',
      'firebaserules.rulesets.delete',
      'firebaserules.releases.list',
      'firebaserules.rulesets.list',
      'firebaserules.releases.getExecutable',
      'datastore.entities.get',
    ])('the rules role may not gain %s', (permission) => {
      const problems = edit(ROLE, (after) => {
        after.permissions = [...after.permissions, permission];
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(permission);
    });

    test.each(['roles/firebaserules.admin', 'roles/firebase.admin', 'roles/firebase.developAdmin'])(
      'a predefined %s in place of the custom role is refused',
      (role) => {
        const problems = edit(GRANT, (after) => {
          after.role = role;
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('role');
      },
    );

    test('the rules role goes to the deploy account only, with no condition', () => {
      for (const name of [`dryscope-api-${environment}`, `dryscope-scheduler-${environment}`]) {
        expect(
          edit(GRANT, (after) => {
            after.member = `serviceAccount:${account(name)}`;
          }),
        ).toHaveLength(1);
      }
      // Firebase Rules evaluates no resource condition; one here would look narrower than it is.
      const conditioned = edit(GRANT, (after) => {
        after.condition = [
          { title: 'one release', expression: "resource.name.endsWith('dryscope-field-test')" },
        ];
      });
      expect(conditioned).toHaveLength(1);
      expect(conditioned[0]).toContain('condition');
    });

    test('a second rules grant to another account is refused', () => {
      const changed = plan();
      const copy = structuredClone(find(changed, GRANT));
      copy.address = 'google_project_iam_member.api_rules_release';
      copy.change.after.member = `serviceAccount:${account(`dryscope-api-${environment}`)}`;
      changed.push(copy);
      expect(checkPlan(changed, { root: 'data', environment })).toEqual([
        'google_project_iam_member.api_rules_release: not in the expected data inventory',
      ]);
    });
  },
);
