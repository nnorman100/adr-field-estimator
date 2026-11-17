// The drain wait in the test release (.github/workflows/web-release.yml, deploy job, step `drain`;
// docs/plans/S8/S8-2.md). The database connection budget (web/src/db/client.ts and
// web/tests/unit/connection-budget.test.ts) counts two revisions holding connections during a
// release: the one serving and the one being staged. That holds only if a revision that lost its
// traffic has no instances left when the next one is staged, and Cloud Run keeps an idle instance
// for up to 15 minutes. These run the real step, with gcloud, curl and sleep faked and the real
// web/scripts/release-drain.ts.
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { load, RELEASE, ROOT, Shell, step, steps, type Data } from './workflow_support.ts';

const release: Data = load(RELEASE);
const deploy = release.jobs.deploy;
const drain = () => step(deploy, 'drain');
const TOKEN = 'ya29.fake-token';

const shells: Shell[] = [];
afterEach(() => {
  for (const s of shells.splice(0)) rmSync(s.tmp, { recursive: true, force: true });
});

// One run of the drain step, the service having last changed `minutesAgo` minutes before.
function runDrain(minutesAgo: number | null, { curlFails = false } = {}) {
  const s = new Shell();
  shells.push(s);
  const updateTime =
    minutesAgo === null ? '' : new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const service = JSON.stringify(minutesAgo === null ? { name: 'x' } : { name: 'x', updateTime });
  s.fake('gcloud', `echo ${TOKEN}`);
  s.fake('curl', `cat > "$HOME/curl-stdin"; ${curlFails ? 'exit 22' : `echo '${service}'`}`);
  s.fake('sleep');
  const result = s.run(drain().run, release.env, ROOT);
  const header = readFileSync(path.join(s.tmp, 'curl-stdin'), 'utf8');
  return { s, result, header, slept: s.calls('sleep').map((args) => Number(args[0])) };
}

describe('the drain wait before staging', () => {
  it('runs after the deploy account signs in and before the traffic is read or a revision staged', () => {
    const order = steps(deploy).map((s: Data) => s.id || s.uses || s.name);
    const at = (key: string) => order.findIndex((k: string) => k.startsWith(key));
    expect(at('drain')).toBeGreaterThan(at('google-github-actions/setup-gcloud@'));
    expect(at('drain')).toBeGreaterThan(at('actions/setup-node@'));
    expect(at('drain')).toBeLessThan(at('before'));
    expect(at('drain')).toBeLessThan(at('stage'));
    expect(drain().if ?? null).toBeNull();
  });

  it('keeps two revisions at most: a release 5 minutes after a traffic move stages only 15 minutes after it', () => {
    const { result, slept } = runDrain(5);
    expect(result.status).toBe(0);
    expect(slept).toHaveLength(1);
    // 10 minutes left of the 15, give or take the second the run takes.
    expect(slept[0]).toBeGreaterThanOrEqual(598);
    expect(slept[0]).toBeLessThanOrEqual(600);
  });

  it('does not wait when the service last changed more than 15 minutes ago', () => {
    const { result, slept } = runDrain(16);
    expect(result.status).toBe(0);
    expect(slept).toEqual([0]);
  });

  it("reads the test service's last change from Cloud Run as the deploy account, with the token on stdin", () => {
    const { s, header } = runDrain(1);
    expect(s.calls('gcloud')).toEqual([['auth', 'print-access-token']]);
    const [args] = s.calls('curl');
    expect(args).toContain(
      'https://run.googleapis.com/v2/projects/dryscope/locations/us-central1/services/dryscope-api-test',
    );
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(header.trim()).toBe(`Authorization: Bearer ${TOKEN}`);
  });

  it.each([
    ['Cloud Run cannot be read', 1, true],
    ['the service has no updateTime', null, false],
  ] as const)(
    'stops the release without waiting or staging when %s',
    (_label, minutesAgo, curlFails) => {
      const { result, slept } = runDrain(minutesAgo, { curlFails });
      expect(result.status).toBe(1);
      expect(slept).toEqual([]);
      expect(result.stdout).toContain('traffic did not move');
    },
  );

  it('leaves the deploy job time for the full wait and the release after it', () => {
    expect(deploy['timeout-minutes']).toBeGreaterThanOrEqual(15 + 15);
  });
});
