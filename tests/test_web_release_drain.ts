// The drain wait in the test release (.github/workflows/web-release.yml, deploy job, step `drain`;
// docs/plans/S8/S8-2.md). The database connection budget (web/src/db/client.ts and
// web/tests/unit/connection-budget.test.ts) counts two revisions holding connections during a
// release: the one serving and the one being staged. That holds only if a revision that lost its
// traffic has no instances left when the next one is staged, and Cloud Run keeps an idle instance
// for up to 15 minutes. These run the real step, with gcloud, curl and sleep faked and the real
// web/scripts/release-drain.ts.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// One run of the drain step. Each read of the service answers the next entry: how many minutes
// before that read the service last changed, null for a service without updateTime, or 'fail' for
// a read that fails. sleep is faked, so the minutes are as the step would see them at that read.
function runDrain(...reads: (number | null | 'fail')[]) {
  const s = new Shell();
  shells.push(s);
  const answers = reads.map((read) =>
    read === 'fail'
      ? 'fail'
      : JSON.stringify(
          read === null
            ? { name: 'x' }
            : { name: 'x', updateTime: new Date(Date.now() - read * 60_000).toISOString() },
        ),
  );
  writeFileSync(path.join(s.tmp, 'answers'), answers.join('\n') + '\n');
  s.fake('gcloud', `echo ${TOKEN}`);
  s.fake(
    'curl',
    [
      'cat > "$HOME/curl-stdin"',
      'n=$(( $(cat "$HOME/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$HOME/n"',
      'answer=$(sed -n "${n}p" "$HOME/answers")',
      '[ "$answer" != fail ] || exit 22',
      'echo "$answer"',
    ].join('\n'),
  );
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
    // The second read, after the wait, finds the service unchanged for 15 minutes.
    const { s, result, slept } = runDrain(5, 15);
    expect(result.status).toBe(0);
    expect(s.calls('curl')).toHaveLength(2);
    expect(slept).toHaveLength(1);
    // 10 minutes left of the 15, give or take the second the run takes.
    expect(slept[0]).toBeGreaterThanOrEqual(598);
    expect(slept[0]).toBeLessThanOrEqual(600);
  });

  it('does not wait when the service last changed more than 15 minutes ago', () => {
    const { s, result, slept } = runDrain(16);
    expect(result.status).toBe(0);
    expect(slept).toEqual([]);
    expect(s.calls('curl')).toHaveLength(1);
  });

  it('waits again when the service changes during the wait, such as a rollback by hand', () => {
    // 5 minutes after a move; a rollback lands 2 minutes before the wait ends; then quiet.
    const { result, slept } = runDrain(5, 2, 15);
    expect(result.status).toBe(0);
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThanOrEqual(778);
    expect(slept[1]).toBeLessThanOrEqual(780);
  });

  it('stops the release without staging when the service keeps changing through two waits', () => {
    const { result, slept } = runDrain(1, 1, 1);
    expect(result.status).toBe(1);
    expect(slept).toHaveLength(2);
    expect(result.stdout).toContain('traffic did not move');
  });

  it("reads the test service's last change from Cloud Run as the deploy account, with the token on stdin", () => {
    const { s, header } = runDrain(1, 16);
    expect(s.calls('gcloud')).toEqual([
      ['auth', 'print-access-token'],
      ['auth', 'print-access-token'],
    ]);
    const [args] = s.calls('curl');
    expect(args).toContain(
      'https://run.googleapis.com/v2/projects/dryscope/locations/us-central1/services/dryscope-api-test',
    );
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(header.trim()).toBe(`Authorization: Bearer ${TOKEN}`);
  });

  it.each([
    ['Cloud Run cannot be read', ['fail'], 0],
    ['the service has no updateTime', [null], 0],
    ['the read after a wait fails', [5, 'fail'], 1],
  ] as const)('stops the release without staging when %s', (_label, reads, waits) => {
    const { result, slept } = runDrain(...reads);
    expect(result.status).toBe(1);
    expect(slept).toHaveLength(waits);
    expect(result.stdout).toContain('traffic did not move');
  });

  it('leaves the deploy job time for two full waits and the release after them', () => {
    expect(deploy['timeout-minutes']).toBeGreaterThanOrEqual(15 + 15 + 15);
  });
});
