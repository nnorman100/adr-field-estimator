import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { connectionOptions } from '@/db/client';
import { parseConfig } from '@/lib/config';

// The environment Terraform gives each Cloud Run service (infra/dryscope/app/cloud_run.tf), read
// from the mocked plan fixtures (regenerate with `node infra/dryscope/scripts/check-plan.js export`
// after a Terraform change). If Terraform and the app's config disagree on a name or format, the
// container would exit at start; this fails first.
type EnvEntry = { name: string; value: string; value_source: unknown[] };
type Change = {
  address: string;
  change: { after: { template: { containers: { env: EnvEntry[] }[] }[] } };
};

function serviceEnv(environment: string, service: string): Record<string, string> {
  const file = new URL(`../../../infra/dryscope/fixtures/app-${environment}.plan.json`, import.meta.url);
  const plan = JSON.parse(readFileSync(file, 'utf8')) as { resource_changes: Change[] };
  const address = `google_cloud_run_v2_service.svc["${service}"]`;
  const svc = plan.resource_changes.find((r) => r.address === address);
  if (!svc) throw new Error(`no ${service} service in the ${environment} plan`);
  const env: Record<string, string> = {};
  // Secret references carry no value in a plan; the config does not read them.
  for (const e of svc.change.after.template[0]!.containers[0]!.env) {
    if (e.value_source.length === 0) env[e.name] = e.value;
  }
  return env;
}

describe.each(['test', 'live'] as const)('Terraform-provided environment (%s)', (environment) => {
  it.each(['api', 'live'])('the %s service config parses and opens its own Cloud SQL', (service) => {
    const config = parseConfig(serviceEnv(environment, service));
    expect(config.appEnv).toBe(environment);
    expect(config.databaseUrl).toBeNull();
    expect(config.cloudSql).toEqual({
      connectionName: `dryscope:us-central1:dryscope-${environment}-pg`,
      database: 'dryscope',
      user: `dryscope-${service}-${environment}@dryscope.iam`,
    });
    const token = async () => 'token';
    const { url, options } = connectionOptions(config, token);
    expect(url).toBeNull();
    expect(options).toMatchObject({
      path: `/cloudsql/dryscope:us-central1:dryscope-${environment}-pg/.s.PGSQL.5432`,
      database: 'dryscope',
      username: `dryscope-${service}-${environment}@dryscope.iam`,
      password: token,
    });
  });
});
