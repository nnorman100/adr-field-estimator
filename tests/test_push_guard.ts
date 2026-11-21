// The Claude Code PreToolUse hook (scripts/push-guard.mjs) refuses force-pushes and pushes to master
// in every form agents write, which the permission rules in .claude/settings.json cannot match.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { checkCommand } from '../scripts/push-guard.mjs';

const ROOT = path.resolve(__dirname, '..');
const onBranch =
  (branch: string, pushTarget = '') =>
  () => ({ branch, pushTarget });
const check = (command: string, branch = 'fm/task', pushTarget = '') =>
  checkCommand(command, { cwd: '/repo', branchOf: onBranch(branch, pushTarget) });

test.each([
  'git push --force origin fm/task',
  'git push -f',
  'git -C /repo push --force origin fm/task',
  'git -C /repo push origin fm/task --force',
  'git -C /repo push -uf origin fm/task',
  'git -C /repo push --force-with-lease=fm/task origin fm/task',
  'git -C . push origin +fm/task',
  'git -c push.default=current push -f',
  '/usr/bin/git --no-pager push -f origin fm/task',
  'env GIT_TRACE=1 git push -f',
])('refuses a force-push: %s', (command) => {
  expect(check(command)).toMatch(/force-push/);
});

test.each([
  'git push origin master',
  'git -C /repo push origin master',
  'git -C /repo push origin HEAD:master',
  'git -C /repo push origin fm/task:refs/heads/master',
  'git -C /repo push origin :master',
  'git -C /repo push origin --delete master',
  'git -C /repo push -o ci.skip origin master',
  'GIT_SSH_COMMAND=ssh git -C /repo push origin master',
  'timeout 60 git -C /repo push origin master',
])('refuses a push to master: %s', (command) => {
  expect(check(command)).toMatch(/push to master/);
});

test.each(['git -C /repo push --all origin', 'git push --mirror origin'])(
  'refuses a push of every branch: %s',
  (command) => {
    expect(check(command)).toMatch(/every branch/);
  },
);

test('a push of the current branch is refused when that branch, or its push target, is master', () => {
  expect(check('git -C /repo push', 'master')).toMatch(/current branch/);
  expect(check('git -C /repo push origin HEAD', 'master')).toMatch(/current branch/);
  expect(check('git -C /repo push', 'fm/task', 'refs/remotes/origin/master')).toMatch(
    /current branch/,
  );
  expect(check('git -C /repo push', 'fm/task', 'refs/remotes/origin/fm/task')).toBeNull();
});

test('the branch is read in the directory the push runs in', () => {
  const dirs: string[] = [];
  const branchOf = (dir: string) => {
    dirs.push(dir);
    return { branch: 'fm/task', pushTarget: '' };
  };
  checkCommand('git -C sub push', { cwd: '/base', branchOf });
  checkCommand('cd /other && git push', { cwd: '/base', branchOf });
  checkCommand('git -C /a -C b push origin HEAD', { cwd: '/base', branchOf });
  expect(dirs).toEqual(['/base/sub', '/other', '/a/b']);
});

test.each([
  'npm test && git -C /repo push -f origin fm/task',
  'git -C /repo status; git -C /repo push origin master',
  "bash -c 'git -C /repo push --force'",
  'sh -lc "git push origin master"',
  'eval git push -f',
  'echo "$(git push -f)"',
  'echo `git push origin master`',
  '(cd /repo && git push -f) 2>&1 | tail -5',
])('finds the push inside a compound or nested command: %s', (command) => {
  expect(check(command)).not.toBeNull();
});

test.each([
  'git -C /repo push -u origin fm/task',
  'git -C /repo push origin HEAD',
  'git -C /repo push origin fm/task:fm/task',
  'git -C /repo push --follow-tags origin fm/task',
  'git -C /repo push origin master-notes',
  'git -C /repo push origin fm/task 2>&1 | tail -3',
  'git -C /repo log --oneline origin/master',
  'git -C /repo fetch origin master',
  'git -C /repo commit -m "never git push -f to master"',
  'echo git push --force',
  'gh-axi pr view 452',
])('allows an ordinary command: %s', (command) => {
  expect(check(command)).toBeNull();
});

test('a quoted here-document body is text; an unquoted one and the lines after it are checked', () => {
  const body =
    'Tried `git -C /x push --force origin fm/none`: refused.\nAlso git push origin master.';
  expect(check(`cat > /tmp/pr.md <<'EOF'\n${body}\nEOF\ngh-axi pr view 1`)).toBeNull();
  expect(check(`cat <<"EOF" | gh-axi pr comment 1 --body-file -\n${body}\nEOF`)).toBeNull();
  expect(check(`cat <<-\\EOF > /tmp/x\n\t${body}\n\tEOF`)).toBeNull();
  expect(check(`cat <<EOF > /tmp/x\n$(git push -f)\nEOF`)).toMatch(/force-push/);
  expect(check(`cat <<'EOF' > /tmp/x\n${body}\nEOF\ngit -C /repo push -f`)).toMatch(/force-push/);
});

const runHook = (input: unknown) =>
  spawnSync('node', [path.join(ROOT, 'scripts/push-guard.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });

test('as a hook it prints a PreToolUse deny decision and exits 0', () => {
  const r = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'git -C /nonexistent push --force origin fm/task' },
    cwd: ROOT,
  });
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe('PreToolUse');
  expect(out.permissionDecision).toBe('deny');
  expect(out.permissionDecisionReason).toMatch(/force-push/);
});

test('as a hook it stays silent for allowed commands, other tools and unreadable input', () => {
  const allowed = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'git -C /nonexistent push origin fm/task' },
    cwd: ROOT,
  });
  const otherTool = runHook({ tool_name: 'Read', tool_input: { file_path: 'x' } });
  const garbage = spawnSync('node', [path.join(ROOT, 'scripts/push-guard.mjs')], {
    input: 'not json',
    encoding: 'utf8',
  });
  for (const r of [allowed, otherTool, garbage]) {
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }
});

test('.claude/settings.json runs the hook on every Bash call and keeps the matching rules', () => {
  const settings = JSON.parse(readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const bashHooks = settings.hooks.PreToolUse.filter(
    (h: { matcher: string }) => h.matcher === 'Bash',
  ).flatMap((h: { hooks: { command: string; if?: string }[] }) => h.hooks);
  const guard = bashHooks.find((h: { command: string }) => h.command.includes('push-guard.mjs'));
  expect(guard).toBeDefined();
  expect(guard.if).toBeUndefined(); // an `if` filter is best-effort and would skip `sh -c` forms
  const { deny, ask } = settings.permissions;
  expect(deny).toEqual(
    expect.arrayContaining([
      'Bash(git push --force:*)',
      'Bash(git push -f:*)',
      'Bash(git push origin master:*)',
      'Bash(git * push --force*)',
      'Bash(git * push -f*)',
      'Bash(git * push origin master*)',
      'Read(./**/*.key)',
      'Read(./**/*.tfstate)',
      'Read(./**/*.tfstate.*)',
      'Read(~/.config/gcloud/**)',
    ]),
  );
  expect(ask).toEqual(
    expect.arrayContaining([
      'Bash(gh pr merge:*)',
      'Bash(gh pr edit:*)',
      'Bash(gh-axi pr merge:*)',
      'Bash(gh-axi pr edit:*)',
    ]),
  );
});
