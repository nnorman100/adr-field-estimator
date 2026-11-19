// The required `node` job in .github/workflows/ci.yml (owner decision 3a, 2026-11-19) also runs the
// offline infra/dryscope/scripts/check.sh with Terraform downloaded against a pinned SHA-256, so a
// failing check fails a required check. These tests run the job's real step scripts.
// Run by vitest in the node CI job.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { load, Shell, WORKFLOWS, type Data } from './workflow_support.ts';

const ci = (): Data => load(path.join(WORKFLOWS, 'ci.yml'));
const step = (job: string, name: string): Data => {
  const found = (ci().jobs[job].steps as Data[]).find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name} in ${job}`);
  return found;
};
const INSTALL = 'Install Terraform with a pinned checksum';

const shells: Shell[] = [];
afterEach(() => {
  for (const sh of shells.splice(0)) rmSync(sh.tmp, { recursive: true, force: true });
});
const shell = (): Shell => {
  const sh = new Shell();
  shells.push(sh);
  return sh;
};

/** Runs the install step with a stand-in curl that writes `zip` and a stand-in unzip. */
function install(zip: string, sha256: string): { status: number | null; sh: Shell; env: string } {
  const sh = shell();
  sh.fake(
    'curl',
    `while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp '${zip}' "$2"; fi; shift; done`,
  );
  sh.fake('unzip');
  const temp = path.join(sh.tmp, 'runner-temp');
  mkdirSync(temp);
  const env = path.join(sh.tmp, 'env');
  const result = sh.run(step('node', INSTALL).run, {
    ...ci().jobs.node.env,
    TF_SHA256: sha256,
    RUNNER_TEMP: temp,
    GITHUB_ENV: env,
  });
  return { status: result.status, sh, env };
}

describe('the offline Terraform check in the required node job', () => {
  it('runs on every CI event with read-only permissions, and never ignores a failure', () => {
    const job = ci().jobs.node;
    expect(job).not.toHaveProperty('if');
    expect(job).not.toHaveProperty('permissions');
    expect(job).not.toHaveProperty('continue-on-error');
    expect(ci().permissions).toEqual({ contents: 'read' });
    for (const s of job.steps as Data[]) {
      expect(s, s.name ?? s.uses ?? s.run).not.toHaveProperty('if');
      expect(s, s.name ?? s.uses ?? s.run).not.toHaveProperty('continue-on-error');
    }
  });

  it.each([
    [0, 0],
    [1, 1],
  ])('the check step exits %i when check.sh exits %i', (code, expected) => {
    // A stand-in check.sh at the path the step runs, so the step's own exit status is observed.
    const sh = shell();
    const script = path.join(sh.tmp, 'infra', 'dryscope', 'scripts', 'check.sh');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, `#!/bin/bash\necho ran >> '${sh.log}'\nexit ${code}\n`);
    chmodSync(script, 0o755);
    const result = sh.run(step('node', 'Offline Terraform checks').run);
    expect(result.status).toBe(expected);
    expect(existsSync(sh.log)).toBe(true);
  });

  it('installs a download whose checksum matches and puts it on TERRAFORM', () => {
    const sh = shell();
    const zip = path.join(sh.tmp, 'download.zip');
    execFileSync('bash', ['-c', `printf 'terraform bytes' > '${zip}'`]);
    const sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
    const run = install(zip, sha);
    expect(run.status).toBe(0);
    expect(run.sh.calls('unzip')).toHaveLength(1);
    expect(readFileSync(run.env, 'utf8')).toMatch(/^TERRAFORM=.*\/tf-bin\/terraform$/m);
  });

  it('refuses a download whose checksum differs, before unpacking it', () => {
    const sh = shell();
    const zip = path.join(sh.tmp, 'download.zip');
    execFileSync('bash', ['-c', `printf 'tampered' > '${zip}'`]);
    const run = install(zip, ci().jobs.node.env.TF_SHA256);
    expect(run.status).not.toBe(0);
    expect(run.sh.calls('curl')).toHaveLength(1);
    expect(run.sh.calls('unzip')).toEqual([]);
    expect(existsSync(run.env)).toBe(false);
  });

  it('installs Terraform before running the check', () => {
    const names = (ci().jobs.node.steps as Data[]).map((s) => s.name);
    expect(names.indexOf(INSTALL)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(INSTALL)).toBeLessThan(names.indexOf('Offline Terraform checks'));
  });
});
