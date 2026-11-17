import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAIN_POOL_CONNECTIONS, PROBE_CONNECTIONS } from '@/db/client';
import { PROJECTION_CONNECTIONS } from '@/lib/projection/services';
import { parseTfvars } from './tfvars';

// The database connection budget (docs/plans/S8/S8-2.md; the sizing rule beside
// MAIN_POOL_CONNECTIONS in web/src/db/client.ts). Every pool one web app instance opens, times the
// maximum instances of the two revisions that can run at once (the serving one and the candidate or
// draining one), plus the migrator and a reserve, must stay within the database's max_connections.

type Environment = 'test' | 'live';

// Each environment's max_connections. These are Cloud SQL's defaults for the tiers in
// infra/dryscope/data/envs/*.tfvars (db-f1-micro 25; db-custom-1-3840, 3.75 GB, 100) until the owner
// reads the real values (runbook step K) and records them here.
const DATABASE_CONNECTION_LIMIT: Record<Environment, number> = { test: 25, live: 100 };

// Two, because the test release stages a revision only 15 minutes after the last traffic move, when
// a revision that lost its traffic has drained (tests/test_web_release_drain.ts).
const REVISIONS = 2;
const MIGRATOR = 1;
const RESERVE = 10;
const PER_INSTANCE = MAIN_POOL_CONNECTIONS + PROJECTION_CONNECTIONS + PROBE_CONNECTIONS;

const tfvarsText = (environment: Environment) =>
  readFileSync(
    new URL(`../../../infra/dryscope/app/envs/${environment}.tfvars`, import.meta.url),
    'utf8',
  );

// The web app's maximum instances, as the tfvars set api_scaling.max_instances, and the budget.
function budget(tfvars: string) {
  const scaling = parseTfvars(tfvars).api_scaling;
  const instances = (scaling as { max_instances?: unknown } | undefined)?.max_instances;
  if (!Number.isInteger(instances) || (instances as number) < 1) {
    throw new Error('the tfvars set no whole api_scaling.max_instances');
  }
  return {
    instances,
    connections: REVISIONS * (instances as number) * PER_INSTANCE + MIGRATOR + RESERVE,
  };
}

describe('the database connection budget', () => {
  it('counts every pool an instance opens', () => {
    expect({
      main: MAIN_POOL_CONNECTIONS,
      renewal: PROJECTION_CONNECTIONS,
      probe: PROBE_CONNECTIONS,
    }).toEqual({
      main: 3,
      renewal: 2,
      probe: 1,
    });
  });

  it.each([
    ['test', 1, 23],
    ['live', 7, 95],
  ] as const)(
    'fits %s: two revisions at %i instances, the migrator and the reserve make %i',
    (environment, instances, connections) => {
      const found = budget(tfvarsText(environment));
      expect(found).toEqual({ instances, connections });
      expect(found.connections).toBeLessThanOrEqual(DATABASE_CONNECTION_LIMIT[environment]);
    },
  );

  it.each([
    ['test', 2, 35],
    ['live', 8, 107],
  ] as const)(
    'does not fit %s once its tfvars raise the maximum to %i (%i connections)',
    (environment, raised, connections) => {
      const text = tfvarsText(environment).replace(
        /(api_scaling\s*=\s*\{[^}]*?max_instances\s*=\s*)\d+/,
        `$1${raised}`,
      );
      expect(text).not.toBe(tfvarsText(environment));
      const found = budget(text);
      expect(found.connections).toBe(connections);
      expect(found.connections).toBeGreaterThan(DATABASE_CONNECTION_LIMIT[environment]);
    },
  );

  it('reads only what Terraform would: a commented-out block does not count, and a repeated name is refused', () => {
    const live = 'api_scaling = {\n  max_instances = 2\n}\n';
    expect(
      budget(`/* api_scaling = { max_instances = 1 } */\n# max_instances = 1\n${live}`).instances,
    ).toBe(2);
    expect(() => budget(`${live}${live}`)).toThrow('api_scaling given twice');
    expect(() => budget('api_scaling = {\n  max_instances = var.n\n}\n')).toThrow('tfvars');
    expect(() => budget('api_scaling = {\n  min_instances = 0\n}\n')).toThrow(
      'no whole api_scaling.max_instances',
    );
  });
});
