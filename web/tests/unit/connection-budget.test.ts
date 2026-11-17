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

const REVISIONS = 2;
const MIGRATOR = 1;
const RESERVE = 10;

// The web app's maximum instances, from the api_scaling block of an environment's tfvars.
function webAppMaxInstances(environment: keyof typeof DATABASE_CONNECTION_LIMIT): number {
  const file = new URL(`../../../infra/dryscope/app/envs/${environment}.tfvars`, import.meta.url);
  const block = /^api_scaling\s*=\s*\{([^}]*)\}/m.exec(readFileSync(file, 'utf8'))?.[1];
  const value = block && /^\s*max_instances\s*=\s*(\d+)/m.exec(block)?.[1];
  if (!value) throw new Error(`${environment}.tfvars has no api_scaling.max_instances`);
  return Number(value);
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
