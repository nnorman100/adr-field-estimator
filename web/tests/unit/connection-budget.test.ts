import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAIN_POOL_CONNECTIONS, PROBE_CONNECTIONS } from '@/db/client';
import { PROJECTION_CONNECTIONS } from '@/lib/projection/services';

// The database connection budget (docs/plans/S8/S8-2.md; the sizing rule beside
// MAIN_POOL_CONNECTIONS in web/src/db/client.ts). Every pool one web app instance opens, times the
// maximum instances of the two revisions that can run at once (the serving one and the candidate or
// draining one), plus the migrator and a reserve, must stay within the database's max_connections.

// Each environment's max_connections. These are Cloud SQL's defaults for the tiers in
// infra/dryscope/data/envs/*.tfvars (db-f1-micro 25; db-custom-1-3840, 3.75 GB, 100) until the owner
// reads the real values (runbook step K) and records them here.
const DATABASE_CONNECTION_LIMIT = { test: 25, live: 100 } as const;

// Two, because the test release stages a revision only 15 minutes after the last traffic move, when
// a revision that lost its traffic has drained (tests/test_web_release_drain.ts).
const REVISIONS = 2;
const MIGRATOR = 1;
const RESERVE = 10;

// The web app's maximum instances, from Terraform's own evaluated plan of infra/dryscope/app with
// envs/<env>.tfvars: infra/dryscope/fixtures/app-<env>.plan.json (scripts/check-plan.js export).
// infra/dryscope/scripts/check.sh fails when a fresh export differs from the committed fixture, so
// this is what the tfvars set.
type ResourceChange = {
  address: string;
  change: { after: { template?: { scaling?: { max_instance_count?: number }[] }[] } | null };
};

function webAppMaxInstances(environment: keyof typeof DATABASE_CONNECTION_LIMIT): number {
  const file = new URL(`../../../infra/dryscope/fixtures/app-${environment}.plan.json`, import.meta.url);
  const plan = JSON.parse(readFileSync(file, 'utf8')) as { resource_changes: ResourceChange[] };
  const api = plan.resource_changes.filter((rc) => rc.address === 'google_cloud_run_v2_service.svc["api"]');
  expect(api, `app-${environment}.plan.json plans the web app once`).toHaveLength(1);
  const value = api[0]!.change.after?.template?.[0]?.scaling?.[0]?.max_instance_count;
  if (!Number.isInteger(value) || value! < 1) {
    throw new Error(`app-${environment}.plan.json has no web app max_instance_count`);
  }
  return value!;
}

describe('the database connection budget', () => {
  const perInstance = MAIN_POOL_CONNECTIONS + PROJECTION_CONNECTIONS + PROBE_CONNECTIONS;

  it.each(['test', 'live'] as const)('fits %s: two revisions at the maximum instances, the migrator and the reserve', (environment) => {
    const instances = webAppMaxInstances(environment);
    const budget = REVISIONS * instances * perInstance + MIGRATOR + RESERVE;
    expect({ environment, instances, perInstance, budget, fits: budget <= DATABASE_CONNECTION_LIMIT[environment] }).toEqual({
      environment,
      instances,
      perInstance,
      budget,
      fits: true,
    });
  });
});
