import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_SETTINGS } from '@/lib/config';
import { SERVICES, SETTINGS, settingNames, type Service } from '@/lib/settings-contract';

// The runtime settings list (src/lib/settings-contract.ts) held against what the Terraform in
// infra/dryscope/app actually sets and what config.ts reads. A rename on one side only fails here,
// before a revision starts with a setting the app does not read.
//
// Terraform's side is its own evaluated plan: infra/dryscope/fixtures/app-<env>.plan.json, the
// mocked plan `terraform test -json -verbose` prints (scripts/check-plan.js export).
// infra/dryscope/scripts/check.sh fails when a fresh export differs from the committed fixture.
const ENVIRONMENTS = ['test', 'live'] as const;
const FIXTURES = new URL('../../../infra/dryscope/fixtures/', import.meta.url);

type ResourceChange = { address: string; type: string; change: { after: unknown } };
type Container = { env?: { name: string }[] };

function containersIn(value: unknown): Container[] {
  if (Array.isArray(value)) return value.flatMap(containersIn);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'containers' && Array.isArray(child) ? (child as Container[]) : containersIn(child),
  );
}

// The env names Terraform sets on each service and job, by the service its name belongs to.
function plannedSettings(environment: (typeof ENVIRONMENTS)[number]): Record<Service, string[]> {
  const plan = JSON.parse(
    readFileSync(new URL(`app-${environment}.plan.json`, FIXTURES), 'utf8'),
  ) as {
    resource_changes: ResourceChange[];
  };
  const sets: Partial<Record<Service, string[]>> = {};
  for (const rc of plan.resource_changes) {
    const containers = containersIn(rc.change.after);
    if (containers.length === 0) continue;
    expect(['google_cloud_run_v2_service', 'google_cloud_run_v2_job'], rc.address).toContain(
      rc.type,
    );
    const name = (rc.change.after as { name: string }).name;
    const service = SERVICES.find((s) => name === `dryscope-${s}-${environment}`);
    expect(service, `${rc.address} (${name}) is not a contract service`).toBeDefined();
    expect(sets[service!], `${service} is planned twice`).toBeUndefined();
    sets[service!] = containers.flatMap((c) => (c.env ?? []).map((e) => e.name));
  }
  expect(Object.keys(sets).sort()).toEqual([...SERVICES].sort());
  return sets as Record<Service, string[]>;
}

describe.each(ENVIRONMENTS)(
  'the Terraform in infra/dryscope/app, %s environment',
  (environment) => {
    const sets = plannedSettings(environment);

    it.each(SERVICES)('sets exactly the contract settings for %s', (service) => {
      const expected = settingNames().filter((name) =>
        (SETTINGS[name].services as readonly Service[]).includes(service),
      );
      expect([...sets[service]].sort()).toEqual([...expected].sort());
    });

    it('never sets a setting twice on one service', () => {
      for (const service of SERVICES)
        expect(new Set(sets[service]).size).toBe(sets[service].length);
    });

    it('never sets a developer-machine or tooling setting', () => {
      const everything = new Set(SERVICES.flatMap((service) => sets[service]));
      for (const name of settingNames()) {
        if (SETTINGS[name].source !== 'terraform') expect(everything.has(name), name).toBe(false);
      }
    });
  },
);

describe('the app config', () => {
  it('reads exactly the settings the contract says the web app reads', () => {
    const web = settingNames().filter((name) => SETTINGS[name].reader === 'web');
    expect([...CONFIG_SETTINGS].sort()).toEqual([...web].sort());
  });
});
