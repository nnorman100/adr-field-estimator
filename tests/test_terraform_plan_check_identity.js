// Plan-check cases for the sign-in (S3 identity) additions to the DryScope Terraform: the
// sign-in APIs, the per-tenant sign-in user role dryscopeIdentity<Env>, and the ALLOWED_ORIGINS
// setting on both Cloud Run services, including the in-place update that adds it to services
// already applied. Fixtures and the checker are the ones tests/test_terraform_plan_check.js uses.
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
const check = (plan, root, environment, options = {}) =>
  checkPlan(plan, { root, environment, ...options });

describe.each(['test', 'live'])('data root, %s: sign-in APIs and user role', (environment) => {
  const plan = () => load('data', environment);
  const edit = (address, fn) => {
    const changed = plan();
    fn(find(changed, address).change.after);
    return check(changed, 'data', environment);
  };

  test('the sign-in user role holds exactly users get, create, update and sendEmail', () => {
    const address = 'google_project_iam_custom_role.identity_users';
    const role = find(plan(), address).change.after;
    expect(role.role_id).toBe(`dryscopeIdentity${environment === 'test' ? 'Test' : 'Live'}`);
    expect([...role.permissions].sort()).toEqual([
      'firebaseauth.users.create',
      'firebaseauth.users.get',
      'firebaseauth.users.sendEmail',
      'firebaseauth.users.update',
    ]);
  });

  test.each([
    'firebaseauth.users.delete',
    'firebaseauth.configs.update',
    'firebaseauth.users.createSession',
    'identitytoolkit.tenants.create',
    'identitytoolkit.tenants.setIamPolicy',
  ])('a sign-in user role that also holds %s is refused', (permission) => {
    const problems = edit('google_project_iam_custom_role.identity_users', (after) => {
      after.permissions = [...after.permissions, permission];
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('identity_users: permissions is');
    expect(problems[0]).toContain(permission);
  });

  test('a sign-in user role with a permission swapped out is refused', () => {
    const problems = edit('google_project_iam_custom_role.identity_users', (after) => {
      after.permissions = after.permissions.map((p) =>
        p === 'firebaseauth.users.get' ? 'firebaseauth.users.delete' : p,
      );
    });
    expect(problems).toHaveLength(1);
  });

  test('the sign-in user role under the other environment’s id is refused', () => {
    const other = environment === 'test' ? 'Live' : 'Test';
    const problems = edit('google_project_iam_custom_role.identity_users', (after) => {
      after.role_id = `dryscopeIdentity${other}`;
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('role_id is');
  });

  test.each([
    `projects/dryscope/roles/dryscopeIdentity${environment === 'test' ? 'Test' : 'Live'}`,
    'roles/firebaseauth.admin',
    'roles/identitytoolkit.admin',
  ])('a project-level grant of %s is refused (the role is bound per tenant only)', (role) => {
    const changed = plan();
    changed.push({
      address: 'google_project_iam_member.identity_users["api"]',
      type: 'google_project_iam_member',
      change: {
        actions: ['create'],
        after: {
          project: 'dryscope',
          role,
          member: `serviceAccount:dryscope-api-${environment}@dryscope.iam.gserviceaccount.com`,
          condition: [],
        },
      },
    });
    const problems = check(changed, 'data', environment);
    expect(problems).toEqual([
      'google_project_iam_member.identity_users["api"]: not in the expected data inventory',
    ]);
  });

  test.each(['identitytoolkit.googleapis.com', 'firebaserules.googleapis.com'])(
    'the plan enables %s, and a plan without it is refused',
    (api) => {
      const address = `google_project_service.apis["${api}"]`;
      expect(find(plan(), address).change.after.service).toBe(api);
      const problems = check(
        plan().filter((rc) => rc.address !== address),
        'data',
        environment,
      );
      expect(problems).toEqual([`${address}: expected in the plan but missing`]);
    },
  );
});

// An app root applied before ALLOWED_ORIGINS existed: the saved plan updates both services in
// place to add it. Only that update passes; any other in-place change, a delete or a replace
// still fails.
describe.each(['test', 'live'])('app root, %s: adding the new settings in place', (environment) => {
  const SVC = (k) => `google_cloud_run_v2_service.svc["${k}"]`;
  const origin = `https://dryscope-api-${environment}-570228742694.us-central1.run.app`;
  const envOf = (state) => state.template[0].containers[0].env;
  // Both services as already applied (no ALLOWED_ORIGINS), planned as an in-place update to the
  // current configuration; the provider recomputes the etag.
  const reapply = () => {
    const plan = load('app', environment).map((rc) => {
      if (!rc.address.startsWith('google_cloud_run_v2_service.svc[')) {
        return { ...rc, change: { ...rc.change, actions: ['no-op'] } };
      }
      const before = structuredClone(rc.change.after);
      before.template[0].containers[0].env = envOf(before).filter(
        (e) => e.name !== 'ALLOWED_ORIGINS',
      );
      before.etag = 'applied-etag';
      const after = { ...structuredClone(rc.change.after), etag: null };
      return {
        ...rc,
        change: { actions: ['update'], before, after, after_unknown: { etag: true } },
      };
    });
    return plan;
  };

  test('the fixture services carry this environment’s origin', () => {
    for (const k of ['api', 'live']) {
      const env = envOf(find(load('app', environment), SVC(k)).change.after);
      expect(env.find((e) => e.name === 'ALLOWED_ORIGINS')?.value).toBe(origin);
    }
  });

  test('adding ALLOWED_ORIGINS to both applied services in place passes', () => {
    expect(check(reapply(), 'app', environment)).toEqual([]);
  });

  test('changing ALLOWED_ORIGINS from an earlier value in place passes', () => {
    const plan = reapply();
    const rc = find(plan, SVC('api'));
    envOf(rc.change.before).push({
      name: 'ALLOWED_ORIGINS',
      value: 'https://old.example',
      value_source: [],
    });
    expect(check(plan, 'app', environment)).toEqual([]);
  });

  test.each([
    [
      'another setting changes too',
      (after) => {
        envOf(after).find((e) => e.name === 'FIRESTORE_DATABASE_ID').value = 'dryscope-field-other';
      },
    ],
    [
      'an existing setting is removed',
      (after) => {
        after.template[0].containers[0].env = envOf(after).filter(
          (e) => e.name !== 'EVIDENCE_BUCKET',
        );
      },
    ],
    [
      'a setting nobody listed is added',
      (after) => {
        envOf(after).push({ name: 'DEBUG_AUTH', value: 'true', value_source: [] });
      },
    ],
    [
      'the service account changes',
      (after) => {
        after.template[0].service_account = 'dryscope-api-other@dryscope.iam.gserviceaccount.com';
      },
    ],
    [
      'scaling changes',
      (after) => {
        after.template[0].scaling[0].max_instance_count += 1;
      },
    ],
    [
      'ingress changes',
      (after) => {
        after.ingress = 'INGRESS_TRAFFIC_INTERNAL_ONLY';
      },
    ],
  ])('an in-place update where %s is refused', (_, fn) => {
    const plan = reapply();
    fn(find(plan, SVC('api')).change.after);
    const problems = check(plan, 'app', environment);
    expect(problems.some((p) => p.includes(`${SVC('api')}: plan would change it in place`))).toBe(
      true,
    );
  });

  test('a change inside the template is not hidden by marking the template unknown', () => {
    const plan = reapply();
    const rc = find(plan, SVC('api'));
    rc.change.after_unknown = { etag: true, template: true };
    rc.change.after.template[0].timeout = '3600s';
    expect(check(plan, 'app', environment)).toEqual([
      `${SVC('api')}: plan would change it in place; a first apply only creates`,
    ]);
  });

  test.each([
    'https://*.run.app',
    `https://dryscope-api-${environment === 'test' ? 'live' : 'test'}-570228742694.us-central1.run.app`,
  ])('ALLOWED_ORIGINS set to %s is refused, in place or on create', (value) => {
    for (const plan of [reapply(), load('app', environment)]) {
      envOf(find(plan, SVC('live')).change.after).find((e) => e.name === 'ALLOWED_ORIGINS').value =
        value;
      expect(check(plan, 'app', environment)).toEqual([
        `${SVC('live')}: env ALLOWED_ORIGINS is ${JSON.stringify(value)}, expected ${origin}`,
      ]);
    }
  });

  test('a service planned without ALLOWED_ORIGINS is refused', () => {
    const plan = load('app', environment);
    const after = find(plan, SVC('api')).change.after;
    after.template[0].containers[0].env = envOf(after).filter((e) => e.name !== 'ALLOWED_ORIGINS');
    expect(check(plan, 'app', environment)).toEqual([
      `${SVC('api')}: env ALLOWED_ORIGINS is undefined, expected ${origin}`,
    ]);
  });

  test.each([[['delete']], [['delete', 'create']], [['create', 'delete']]])(
    'a service planned as %j is still refused',
    (actions) => {
      const plan = reapply();
      find(plan, SVC('api')).change.actions = actions;
      const problems = check(plan, 'app', environment);
      expect(problems.some((p) => p.includes(`${SVC('api')}: plan would delete or replace`))).toBe(
        true,
      );
    },
  );

  test('an in-place update of any other resource is still refused', () => {
    const plan = reapply();
    const role = find(plan, 'google_project_iam_custom_role.deploy');
    role.change = { actions: ['update'], before: role.change.after, after: role.change.after };
    expect(check(plan, 'app', environment)).toEqual([
      'google_project_iam_custom_role.deploy: plan would change it in place; a first apply only creates',
    ]);
  });

  test('the data root accepts no in-place settings update', () => {
    expect(expectedPlan('data', environment).settings).toEqual({});
  });
});
