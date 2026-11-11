import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_SETTINGS } from '@/lib/config';
import { SERVICES, SETTINGS, settingNames, type Service } from '@/lib/settings-contract';

// The runtime settings list (src/lib/settings-contract.ts) held against the Terraform that sets
// them (infra/dryscope/app) and the code that reads them. A rename on one side only fails here,
// before a revision starts with a setting the app does not read.
const APP_DIR = new URL('../../../infra/dryscope/app/', import.meta.url);
const SRC_DIR = new URL('../../src/', import.meta.url);

function tf(name: string): string {
  return readFileSync(new URL(name, APP_DIR), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

// The text between the braces that open right after `marker`.
function blockAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${marker} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`${marker} is not closed`);
}

// The keys of a map literal at its own level (not those of maps nested in it).
function mapKeys(block: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const line of block.split('\n')) {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (depth === 0 && key) keys.push(key[1]!);
    for (const ch of line) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
  }
  return keys;
}

const literalEnv = (source: string) => [...source.matchAll(/\benv\s*\{\s*name\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
const dynamicEnvSources = (source: string) =>
  [...source.matchAll(/dynamic\s+"env"\s*\{\s*for_each\s*=\s*([^\n]+)/g)].map((m) => m[1]!.trim());

// What Terraform sets by name on each service, read from the .tf files.
function terraformSettings(): Record<Service, string[]> {
  const cloudRun = tf('cloud_run.tf');
  const migrate = tf('migrate_job.tf');
  const services = mapKeys(blockAfter(cloudRun, 'services = {'));
  expect(services.sort()).toEqual(['api', 'live']);
  const common = mapKeys(blockAfter(cloudRun, 'common_env = {'));
  const own = literalEnv(cloudRun);
  return { api: [...common, ...own], live: [...common, ...own], migrate: literalEnv(migrate) };
}

describe('the Terraform in infra/dryscope/app', () => {
  const sets = terraformSettings();

  it.each(SERVICES)('sets exactly the contract settings for %s', (service) => {
    const expected = settingNames().filter((name) => (SETTINGS[name].services as readonly Service[]).includes(service));
    expect([...sets[service]].sort()).toEqual([...expected].sort());
  });

  it('never sets a setting twice on one service', () => {
    for (const service of SERVICES) expect(new Set(sets[service]).size).toBe(sets[service].length);
  });

  it('never sets a developer-machine or tooling setting', () => {
    const everything = new Set(SERVICES.flatMap((service) => sets[service]));
    for (const name of settingNames()) {
      if (SETTINGS[name].source !== 'terraform') expect(everything.has(name), name).toBe(false);
    }
  });

  it('adds settings from nowhere else (no other env block or source)', () => {
    // Secret Manager references are the only other source; the app reads none yet.
    expect(dynamicEnvSources(tf('cloud_run.tf')).sort()).toEqual([
      'local.common_env',
      'toset(local.service_secrets[each.key])',
    ]);
    expect(dynamicEnvSources(tf('migrate_job.tf'))).toEqual([]);
    const withEnv = readdirSync(APP_DIR)
      .filter((file) => file.endsWith('.tf'))
      .filter((file) => /\benv\s*\{|dynamic\s+"env"/.test(tf(file)));
    expect(withEnv.sort()).toEqual(['cloud_run.tf', 'migrate_job.tf']);
  });
});

describe('the app config', () => {
  it('declares exactly the settings the contract says the web app reads', () => {
    const web = settingNames().filter((name) => SETTINGS[name].reader === 'web');
    expect([...CONFIG_SETTINGS].sort()).toEqual([...web].sort());
  });

  it('reads no environment variable that the contract does not list', () => {
    const found = new Set<string>();
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) walk(child);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(child, 'utf8');
          for (const m of source.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g)) {
            found.add((m[1] ?? m[2])!);
          }
        }
      }
    };
    walk(SRC_DIR);
    expect(found.size).toBeGreaterThan(0);
    for (const name of found) expect(settingNames(), `${name} is read but not in the contract`).toContain(name);
  });
});
