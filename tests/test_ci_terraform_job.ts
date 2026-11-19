// The `terraform` job in .github/workflows/ci.yml (owner decision 3a, 2026-11-19) runs the offline
// infra/dryscope/scripts/check.sh with Terraform downloaded against a pinned SHA-256, and the
// required `node` job fails when it does. These tests run the jobs' real step scripts.
// Run by vitest in the node CI job.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateStep, load, Shell, WORKFLOWS, type Data } from './workflow_support.ts';

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
  const result = sh.run(step('terraform', INSTALL).run, {
    ...ci().jobs.terraform.env,
    TF_SHA256: sha256,
    RUNNER_TEMP: temp,
    GITHUB_ENV: env,
  });
  return { status: result.status, sh, env };
}

describe('the terraform job', () => {
  it('runs on every CI event, with a time limit and read-only permissions', () => {
    const job = ci().jobs.terraform;
    expect(job).not.toHaveProperty('if');
    expect(job).not.toHaveProperty('permissions');
    expect(ci().permissions).toEqual({ contents: 'read' });
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    for (const s of job.steps as Data[]) expect(s, s.name ?? s.uses).not.toHaveProperty('if');
    expect(job.steps.at(-1).run).toBe('infra/dryscope/scripts/check.sh');
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
    const run = install(zip, ci().jobs.terraform.env.TF_SHA256);
    expect(run.status).not.toBe(0);
    expect(run.sh.calls('curl')).toHaveLength(1);
    expect(run.sh.calls('unzip')).toEqual([]);
    expect(existsSync(run.env)).toBe(false);
  });
});

describe('the required node job', () => {
  it('waits for terraform and still reports when terraform fails', () => {
    const job = ci().jobs.node;
    expect(job.needs).toEqual(['terraform']);
    expect(evaluateStep(job.if, {}, true)).toBe(true);
  });

  const requireTerraform = (result: string): number | null => {
    const run = String(step('node', 'Require the terraform job').run).replace(
      /\$\{\{\s*needs\.terraform\.result\s*\}\}/,
      result,
    );
    return shell().run(run).status;
  };

  it('passes when terraform succeeds', () => {
    expect(requireTerraform('success')).toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped'])('fails when terraform is %s', (result) => {
    expect(requireTerraform(result)).not.toBe(0);
  });
});
