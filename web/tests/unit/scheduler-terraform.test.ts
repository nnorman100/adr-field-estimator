import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schedulerCaller } from '@/lib/auth/service-caller';

// The Cloud Scheduler jobs Terraform plans (infra/dryscope/app/scheduler.tf) must call each
// internal job route exactly as serviceRoute accepts it: the account and audience schedulerCaller
// derives from the web app's own Cloud Run settings, and that job's internal route. Read from the
// mocked plans the plan check is tested on (infra/dryscope/fixtures).

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Env = Array<{ name: string; value: string | null }>;
type Target = {
  http_method: string;
  uri: string;
  oidc_token: unknown[];
  oauth_token?: unknown[] | null;
};
type After = { template?: Array<{ containers: Array<{ env: Env }> }>; http_target?: Target[] };
type Change = { address: string; change: { after: After } };

function plan(environment: string): Change[] {
  const file = path.join(REPO, 'infra', 'dryscope', 'fixtures', `app-${environment}.plan.json`);
  return JSON.parse(readFileSync(file, 'utf8')).resource_changes;
}

const after = (changes: Change[], address: string) => {
  const found = changes.find((rc) => rc.address === address);
  if (!found) throw new Error(`${address} is not in the plan`);
  return found.change.after;
};

describe.each(['test', 'live'])('scheduled internal jobs in %s', (environment) => {
  const changes = plan(environment);
  // The plain settings the web app's service runs with.
  const settings = Object.fromEntries(
    (
      after(changes, 'google_cloud_run_v2_service.svc["api"]').template?.[0]?.containers[0]?.env ??
      []
    )
      .filter((e) => e.value != null)
      .map((e) => [e.name, e.value as string]),
  );
  const caller = schedulerCaller(settings);
  const jobs = changes.filter((rc) => rc.address.startsWith('google_cloud_scheduler_job.jobs['));

  it('has the access-projection job', () => {
    expect(jobs.map((rc) => rc.address)).toEqual([
      'google_cloud_scheduler_job.jobs["access-projection"]',
    ]);
  });

  it.each(
    jobs.map(
      (rc) => [rc.address.slice('google_cloud_scheduler_job.jobs["'.length, -2), rc] as const,
    ),
  )('%s sends the token serviceRoute accepts to that job’s route', (job, rc) => {
    const target = rc.change.after.http_target?.[0];
    if (!target) throw new Error(`${rc.address} has no HTTP target`);
    expect(target.http_method).toBe('POST');
    expect(target.oidc_token).toEqual([
      { service_account_email: caller.email, audience: caller.audienceFor(job) },
    ]);
    expect(target.oauth_token ?? []).toEqual([]);

    const url = new URL(target.uri);
    expect((settings.ALLOWED_ORIGINS ?? '').split(',')).toContain(url.origin);
    expect(url.pathname).toBe(`/api/internal/${job}`);
  });
});
