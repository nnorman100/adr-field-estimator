#!/usr/bin/env node
// Claude Code PreToolUse hook (.claude/settings.json): refuses a Bash command that would force-push
// or push to master, whatever form the git command takes. Permission rules match the command text
// as written, so `Bash(git push --force:*)` does not stop `git -C <path> push --force` or
// `git -c k=v push`; this hook reads the command itself. It catches:
//   force: --force, -f (also inside -uf), --force-with-lease, --force-if-includes, a +refspec;
//   master: a refspec whose destination is master or refs/heads/master (HEAD:master, :master,
//   --delete master), --all, --branches and --mirror, and a push with no refspec (or HEAD) while
//   the current branch, or its push target, is master;
//   any form: git -C <dir>, git -c k=v and other global options, VAR=value and wrapper prefixes
//   (env, command, exec, nohup, time, timeout, nice, sudo), compound commands (; && || | &),
//   subshells, $(...) and backticks, `sh -c` / `bash -c` scripts and eval.
// It is not a security boundary against deliberate obfuscation (variables, aliases, scripts);
// GitHub branch protection still guards master. On unreadable input it allows the command.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROTECTED_BRANCH = 'master';
const RULE = 'agents push only their own branch, never to master and never with force';

/** Split shell text into simple commands, each a list of words. Approximate, not a full parser. */
export function splitCommands(text) {
  const commands = [];
  let words = [];
  let word = null;
  let dropNext = false; // the next word is a redirection target, not an argument
  const endWord = () => {
    if (word === null) return;
    if (dropNext) dropNext = false;
    else words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      word = (word ?? '') + text.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let s = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
          s += text[i + 1];
          i += 2;
        } else {
          s += text[i++];
        }
      }
      i++;
      // Commands inside "$(...)" or "`...`" still run: check them too.
      const nested = s.search(/\$\(|`/);
      if (nested !== -1) commands.push(...splitCommands(s.slice(nested).replace(/^\$\(|^`/, '')));
      word = (word ?? '') + s;
    } else if (c === '\\') {
      if (i + 1 < text.length && text[i + 1] !== '\n') word = (word ?? '') + text[i + 1];
      i += 2;
    } else if (c === '#' && word === null) {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? text.length : eol;
    } else if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (';&|\n()`'.includes(c)) {
      endCommand();
      i++;
    } else if (c === '$' && text[i + 1] === '(') {
      endCommand();
      i += 2;
    } else if (c === '<' || c === '>') {
      if (word !== null && /^\d+$/.test(word)) word = null;
      else endWord();
      while (text[i] === '<' || text[i] === '>') i++;
      if (text[i] === '&') i++;
      dropNext = true;
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  endCommand();
  return commands;
}

const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'timeout', 'nice', 'sudo']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const GIT_OPTS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
]);
const PUSH_OPTS_WITH_VALUE = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
const FORCE_OPTS = new Set(['--force', '--force-with-lease', '--force-if-includes']);
const EVERY_BRANCH_OPTS = new Set(['--all', '--branches', '--mirror']);

const base = (word) => word.split('/').pop();
const isAssignment = (word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const isProtected = (ref) => ref.replace(/^refs\/heads\//, '') === PROTECTED_BRANCH;

/** Parse `git <global options> push <args>`; returns null when the git command is not a push. */
export function parsePush(gitArgs, cwd) {
  let dir = cwd;
  let i = 0;
  while (i < gitArgs.length) {
    const a = gitArgs[i];
    if (a === '-C') {
      if (gitArgs[i + 1]) dir = path.resolve(dir, expandHome(gitArgs[i + 1]));
      i += 2;
    } else if (GIT_OPTS_WITH_VALUE.has(a)) i += 2;
    else if (a.startsWith('-')) i++;
    else break;
  }
  if (gitArgs[i] !== 'push') return null;
  const push = { dir, force: false, everyBranch: false, refspecs: [] };
  const positional = [];
  let optionsEnded = false;
  for (let j = i + 1; j < gitArgs.length; j++) {
    const a = gitArgs[j];
    if (optionsEnded || !a.startsWith('-') || a === '-') positional.push(a);
    else if (a === '--') optionsEnded = true;
    else if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (FORCE_OPTS.has(name)) push.force = true;
      else if (EVERY_BRANCH_OPTS.has(name)) push.everyBranch = true;
      else if (PUSH_OPTS_WITH_VALUE.has(name) && !a.includes('=')) j++;
    } else {
      // A short-option cluster such as -uf; -o takes the rest of the word or the next word.
      for (let k = 1; k < a.length; k++) {
        if (a[k] === 'f') push.force = true;
        if (a[k] === 'o') {
          if (k === a.length - 1) j++;
          break;
        }
      }
    }
  }
  push.refspecs = positional.slice(1);
  return push;
}

/** The current branch and its push target in `dir`, or '' for each when git cannot say. */
export function readBranch(dir) {
  const git = (args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  return {
    branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    pushTarget: git(['rev-parse', '--symbolic-full-name', '@{push}']),
  };
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Why this push is refused, or null when it may run. */
export function pushProblem(push, branchOf = readBranch) {
  if (push.force || push.refspecs.some((r) => r.startsWith('+'))) return 'a force-push';
  if (push.everyBranch) return `a push of every branch, ${PROTECTED_BRANCH} included`;
  let implicit = push.refspecs.length === 0;
  for (const refspec of push.refspecs) {
    const colon = refspec.indexOf(':');
    const dest = colon === -1 ? refspec : refspec.slice(colon + 1);
    if (isProtected(dest)) return `a push to ${PROTECTED_BRANCH}`;
    if (colon === -1 && (refspec === 'HEAD' || refspec === '@')) implicit = true;
  }
  if (implicit) {
    const { branch, pushTarget } = branchOf(push.dir);
    if (branch === PROTECTED_BRANCH || pushTarget.endsWith(`/${PROTECTED_BRANCH}`)) {
      return `a push of the current branch, which goes to ${PROTECTED_BRANCH}`;
    }
  }
  return null;
}

/** Check a whole Bash command. Returns the refusal reason, or null when nothing in it is refused. */
export function checkCommand(command, { cwd = process.cwd(), branchOf = readBranch } = {}) {
  let dir = cwd;
  for (const words of splitCommands(command)) {
    let w = words;
    while (w.length && isAssignment(w[0])) w = w.slice(1);
    if (!w.length) continue;
    let program = base(w[0]);
    if (program === 'cd') {
      if (w.length === 1 || w[1] === '~') dir = os.homedir();
      else if (w[1] !== '-') dir = path.resolve(dir, expandHome(w[1]));
      continue;
    }
    if (program === 'eval') {
      const found = checkCommand(w.slice(1).join(' '), { cwd: dir, branchOf });
      if (found) return found;
      continue;
    }
    if (SHELLS.has(program)) {
      const flag = w.findIndex((a, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (flag !== -1 && w[flag + 1] !== undefined) {
        const found = checkCommand(w[flag + 1], { cwd: dir, branchOf });
        if (found) return found;
      }
      continue;
    }
    if (WRAPPERS.has(program)) {
      const git = w.findIndex((a) => base(a) === 'git');
      if (git === -1) continue;
      w = w.slice(git);
      program = 'git';
    }
    if (program !== 'git') continue;
    const push = parsePush(w.slice(1), dir);
    const problem = push && pushProblem(push, branchOf);
    if (problem) {
      return `Blocked by scripts/push-guard.mjs: this is ${problem}. In DryScope ${RULE} (.claude/settings.json, AGENTS.md hard rules). Push your own branch without force and open a PR.`;
    }
  }
  return null;
}

export function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return; // unreadable input: allow, and leave the decision to the other permission layers
  }
  if (input?.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') return;
  const reason = checkCommand(input.tool_input.command, { cwd: input.cwd || process.cwd() });
  if (!reason) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
