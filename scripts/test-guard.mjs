#!/usr/bin/env node
// Test guard: fails a pull request that weakens tests, evaluations or checks,
// unless the repository owner has added the "test-change-approved" label.
//
// It asks for the label only when a change can weaken testing:
//   1. Any change to the guard's own files, or to another protected file
//      (scoring thresholds, eval scripts, test runner configs, CODEOWNERS and
//      everything else under .github/ that is not a workflow).
//   2. A workflow change that removes or disables a job, step, trigger or
//      matrix entry, renames a job (its check name), adds or changes an `if:`
//      or `continue-on-error`, adds an error-swallowing command to an existing
//      step, or could let a workflow approve itself (write access to pull
//      requests, issues, checks or statuses, a dropped `permissions:` key, a
//      new secret, or the label's name).
//      Workflows that never run on pull requests (deploys, releases) are
//      checked for self-approval only.
//   3. A changed, deleted or renamed stored answer (fixtures; their Markdown
//      notes excepted). New ones pass.
//   4. A deleted test file, or one renamed out of the test folders.
//   5. Fewer test definitions than before across the changed test files
//      (moving, renaming or replacing a test passes).
//   6. A newly added skip, only, todo or expected-failure marker.
//   7. Fewer assertion lines than before across the changed test files.
// New test files, new tests, new fixtures, docs and ordinary workflow edits
// (runners, timeouts, pins, new jobs and steps, run text) pass without it.
//
// Usage: node scripts/test-guard.mjs <base-commit>
// Config: .github/test-guard.json, read from the base commit:
//   { "unguarded": [globs], "guard": [globs], "workflows": [globs],
//     "protected": [globs], "fixtures": [globs], "tests": [globs] }
// The first of unguarded, guard, workflows and protected that matches a path
// decides its rule; fixtures and tests apply on top.
// No dependencies: CI runs the base branch's copy of this file with plain node.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const APPROVAL_LABEL = 'test-change-approved';

// ---------------------------------------------------------------- globs

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function matcher(globs) {
  const patterns = (globs || []).map(globToRegExp);
  return (p) => patterns.some((r) => r.test(p));
}

// ---------------------------------------------------------- YAML reader
// A small reader for the block-style YAML that GitHub workflows use:
// mappings, sequences, block scalars (| and >), quoted and plain scalars,
// and simple flow lists. It throws on anything it does not understand, and
// the guard then asks for the label rather than guessing.

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /\s/.test(text[i - 1])) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function scalar(text) {
  const t = text.trim();
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) return JSON.parse(t);
  if (t === '{}') return {};
  if (t === 'null' || t === '~') return null;
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    if (/[[\]{}]/.test(inner)) throw new Error(`nested flow list: ${t}`);
    return inner.split(',').map((part) => scalar(part));
  }
  if (t.startsWith('{') || t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    throw new Error(`unsupported YAML value: ${t}`);
  }
  return t;
}

const KEY = /^((?:"[^"]*"|'[^']*'|[^\s:#'"][^:]*?))\s*:(?:\s+(.*)|)$/;
const BLOCK = /^[|>][-+0-9]*$/;

export function parseYaml(source) {
  if (source.includes('\t')) throw new Error('tabs in YAML');
  const raw = source.replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (let n = 0; n < raw.length; n++) {
    const content = raw[n].trim();
    if (content === '' || content.startsWith('#')) continue;
    if (content === '---' || content === '...') {
      if (lines.length) throw new Error('more than one YAML document');
      continue;
    }
    lines.push({ n, indent: raw[n].length - raw[n].trimStart().length, text: raw[n].trim() });
  }
  let i = 0;

  const isItem = (line) => line.text === '-' || line.text.startsWith('- ');

  function blockScalar(line, indicator) {
    // Raw lines after the key that are indented deeper, blank lines included.
    const out = [];
    let r = line.n + 1;
    let pad = null;
    for (; r < raw.length; r++) {
      const s = raw[r];
      if (s.trim() === '') {
        out.push('');
        continue;
      }
      const ind = s.length - s.trimStart().length;
      if (ind <= line.indent) break;
      if (pad === null) pad = ind;
      out.push(s.slice(Math.min(pad, ind)));
    }
    while (i < lines.length && lines[i].n < r) i++;
    while (out.length && out[out.length - 1] === '') out.pop();
    let text = out.join('\n');
    if (indicator.startsWith('>')) {
      // Folded: lines of a paragraph join with spaces, blank lines end it.
      // More-indented lines keep their line breaks.
      text = text
        .split(/\n{2,}/)
        .map((para) =>
          para
            .split('\n')
            .reduce((acc, l, k, all) =>
              k === 0 ? l : `${acc}${/^\s/.test(l) || /^\s/.test(all[k - 1]) ? '\n' : ' '}${l}`,
            ),
        )
        .join('\n');
    }
    if (indicator.includes('-') || text === '') return text;
    return `${text}\n`;
  }

  function value(line, rest) {
    if (rest === undefined || rest === '') {
      const next = lines[i];
      if (next && next.indent > line.indent) return node(next.indent);
      if (next && next.indent === line.indent && isItem(next) && !line.item) {
        return node(next.indent);
      }
      return null;
    }
    const text = stripComment(rest);
    if (BLOCK.test(text)) return blockScalar(line, text);
    // Plain scalars may continue on deeper-indented lines.
    let joined = text;
    while (i < lines.length && lines[i].indent > line.indent && !KEY.test(lines[i].text)) {
      joined += ` ${stripComment(lines[i].text)}`;
      i++;
    }
    return scalar(joined);
  }

  function mapping(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i])) {
      const line = lines[i];
      const m = KEY.exec(line.text);
      if (!m) throw new Error(`line ${line.n + 1}: expected "key: value"`);
      i++;
      const key = scalar(m[1]);
      if (Object.hasOwn(out, key)) throw new Error(`line ${line.n + 1}: duplicate key ${key}`);
      out[key] = value(line, m[2]);
    }
    return out;
  }

  function sequence(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
      const line = lines[i];
      const after = line.text.slice(1).trimStart();
      if (after === '') {
        i++;
        out.push(value({ ...line, item: true }, ''));
      } else if (KEY.test(after) && !/^["']/.test(after.trim())) {
        // "- key: value" starts a mapping indented to the key's column.
        const col = indent + (line.text.length - after.length);
        lines[i] = { n: line.n, indent: col, text: after };
        out.push(mapping(col));
      } else {
        i++;
        out.push(value({ ...line, item: true }, after));
      }
    }
    return out;
  }

  function node(indent) {
    return isItem(lines[i]) ? sequence(indent) : mapping(indent);
  }

  if (lines.length === 0) return null;
  const doc = node(lines[0].indent);
  if (i < lines.length) throw new Error(`line ${lines[i].n + 1}: unexpected indentation`);
  return doc;
}

// ------------------------------------------------------ workflow checks

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : String(v));
}

// Filters that only narrow when they gain entries, and filters that narrow
// when they lose entries (adding a new one of either kind narrows too).
const NARROWING_FILTERS = ['paths-ignore', 'branches-ignore', 'tags-ignore'];
const WIDENING_FILTERS = ['paths', 'branches', 'tags', 'types'];

function triggerNarrowed(base, head) {
  // Removing a filter makes the workflow run more often, which is fine.
  if (stable(base) === stable(head)) return false;
  const isMap = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isMap(base) && !isMap(head)) return true;
  const b = isMap(base) ? base : {};
  const h = isMap(head) ? head : {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(h)])) {
    if (!Object.hasOwn(h, key)) {
      if (NARROWING_FILTERS.includes(key) || WIDENING_FILTERS.includes(key)) continue;
      return true;
    }
    const list = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]).map(String);
    if (WIDENING_FILTERS.includes(key)) {
      if (!Object.hasOwn(b, key)) return true;
      const have = new Set(list(h[key]));
      if (list(b[key]).some((e) => !have.has(e))) return true;
    } else if (NARROWING_FILTERS.includes(key)) {
      const had = new Set(list(b[key]));
      if (list(h[key]).some((e) => !had.has(e))) return true;
    } else if (stable(b[key]) !== stable(h[key])) {
      return true;
    }
  }
  return false;
}

// Events whose workflows report checks on a pull request.
const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target', 'merge_group'];
const runsOnPullRequests = (wf) =>
  PULL_REQUEST_EVENTS.some((e) => Object.hasOwn(triggers(wf?.on), e));

function triggers(on) {
  if (on == null) return {};
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), null]));
  return on;
}

// Permissions that would let a workflow label its own pull request or
// report a passing check in place of a real one.
const SELF_APPROVAL_SCOPES = ['pull-requests', 'issues', 'checks', 'statuses'];
function grantsSelfApproval(perms) {
  if (perms === 'DEFAULT') return true; // the repository default may allow writes
  if (perms === 'write-all') return true;
  if (!perms || typeof perms !== 'object') return false;
  return SELF_APPROVAL_SCOPES.some((s) => perms[s] === 'write');
}

// Error-swallowing commands that make a failing step pass.
const BYPASS_COMMANDS = [
  /\|\|\s*(?:true|:|exit\s+0|echo)\b/,
  /\|\|\s*:\s*$/,
  /\bset\s+\+e\b/,
  /^\s*exit\s+0\b/,
  /;\s*exit\s+0\b/,
  /--passWithNoTests\b/,
  /--pass-with-no-tests\b/,
  /--exit-zero\b/,
  /--deselect\b/,
  /--ignore(?:=|\s)/,
];

function stepId(step) {
  if (!step || typeof step !== 'object') return `raw:${stable(step)}`;
  if (step.id != null) return `id:${step.id}`;
  if (step.name != null) return `name:${step.name}`;
  if (step.uses != null) return `uses:${String(step.uses).split('@')[0]}`;
  if (step.run != null) {
    // The first command line, with pinned versions dropped so bumps match.
    const first = String(step.run).trim().split('\n')[0].trim();
    return `run:${first.replace(/(==?|@)v?\d[\w.+-]*/g, '')}`;
  }
  return `raw:${stable(step)}`;
}

// Conditions that only make a job or step run in more cases than the default.
const WIDENING_IFS = ['always()', '!cancelled()', 'always() && !cancelled()'];
const widens = (cond) =>
  WIDENING_IFS.includes(
    String(cond)
      .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace(/\s+/g, ' '),
  );

function changedControl(base, head) {
  // A condition or continue-on-error that is new or different. Dropping one
  // makes the job or step run (and fail) more often, so it passes.
  const out = [];
  if (head.if != null && stable(head.if) !== stable(base.if) && !widens(head.if)) out.push('`if:`');
  if (head.shell != null && stable(head.shell) !== stable(base.shell)) out.push('`shell:`');
  const coe = head['continue-on-error'];
  if (coe != null && String(coe) !== 'false' && stable(coe) !== stable(base['continue-on-error'])) {
    out.push('`continue-on-error`');
  }
  return out;
}

function matrixLeaves(matrix, prefix = '') {
  if (matrix == null || typeof matrix !== 'object') return [`${prefix}=${stable(matrix)}`];
  if (Array.isArray(matrix)) return matrix.map((v) => `${prefix}[]=${stable(v)}`);
  return Object.keys(matrix).flatMap((k) =>
    k === 'exclude' ? [] : matrixLeaves(matrix[k], `${prefix}.${k}`),
  );
}

function linesOf(text) {
  return text == null ? [] : String(text).split('\n');
}

function countBy(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

export const checkName = (id, job) => String(job?.name ?? id);

// baseChecks: check names of the jobs in every workflow on the base commit.
export function checkWorkflow(path, baseText, headText, addedLines, baseChecks = new Set()) {
  const v = [];
  for (const line of addedLines) {
    if (line.includes(APPROVAL_LABEL)) v.push(`${path}: names the approval label: ${line.trim()}`);
    if (/\bsecrets\.(?!GITHUB_TOKEN\b)/.test(line)) {
      v.push(`${path}: uses a new secret: ${line.trim().slice(0, 140)}`);
    }
  }

  let base = null;
  let head;
  try {
    if (baseText != null) base = parseYaml(baseText);
    head = parseYaml(headText);
  } catch (err) {
    v.push(`${path}: could not read the workflow's structure (${err.message})`);
    return v;
  }
  const isMap = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (
    !isMap(head) ||
    !isMap(head.jobs) ||
    (baseText != null && !(isMap(base) && isMap(base.jobs)))
  ) {
    v.push(`${path}: could not find the workflow's jobs`);
    return v;
  }

  const workflowPerms = (wf) => (Object.hasOwn(wf, 'permissions') ? wf.permissions : 'DEFAULT');
  const jobPerms = (wf, job) =>
    Object.hasOwn(job, 'permissions') ? job.permissions : workflowPerms(wf);

  for (const [id, job] of Object.entries(head.jobs)) {
    if (!isMap(job)) {
      v.push(`${path}: job ${id} is not a mapping`);
      continue;
    }
    const perms = jobPerms(head, job);
    const before = base && isMap(base.jobs[id]) ? jobPerms(base, base.jobs[id]) : undefined;
    if (grantsSelfApproval(perms) && stable(perms) !== stable(before)) {
      const what = perms === 'DEFAULT' ? 'no `permissions:` key' : `permissions ${stable(perms)}`;
      v.push(
        `${path}: job ${id} gets ${what}, which could approve its own pull request or fake a check`,
      );
    }
  }
  for (const [id, job] of Object.entries(head.jobs)) {
    if (base && Object.hasOwn(base.jobs, id)) continue;
    if (runsOnPullRequests(head) && baseChecks.has(checkName(id, job))) {
      v.push(`${path}: new job ${id} reuses the existing check name "${checkName(id, job)}"`);
    }
  }
  // A new workflow adds checks and removes none. A workflow that never runs
  // on pull requests (deploys, releases, schedules) reports no pull request
  // checks, so only the self-approval rules above apply to it.
  if (!base || !runsOnPullRequests(base)) return v;

  const baseOn = triggers(base.on);
  const headOn = triggers(head.on);
  for (const [event, config] of Object.entries(baseOn)) {
    if (!Object.hasOwn(headOn, event)) {
      v.push(`${path}: trigger removed: ${event}`);
    } else if (triggerNarrowed(config, headOn[event])) {
      v.push(`${path}: trigger ${event} changed (it decides when the checks run)`);
    }
  }

  for (const [id, bj] of Object.entries(base.jobs)) {
    const hj = head.jobs[id];
    if (!isMap(hj)) {
      v.push(`${path}: job removed: ${id}`);
      continue;
    }
    if (!isMap(bj)) continue;
    if (stable(hj.name ?? id) !== stable(bj.name ?? id)) {
      v.push(`${path}: job ${id} renamed (its check name changes)`);
    }
    for (const what of changedControl(bj, hj))
      v.push(`${path}: job ${id} has a new or changed ${what}`);
    const needs = (j) => (Array.isArray(j.needs) ? j.needs : j.needs == null ? [] : [j.needs]);
    const stillNeeds = new Set(needs(hj).map(String));
    for (const n of needs(bj)) {
      if (!stillNeeds.has(String(n))) v.push(`${path}: job ${id} no longer needs ${n}`);
    }

    const bm = bj.strategy?.matrix;
    const hm = hj.strategy?.matrix;
    if (bm != null) {
      if (typeof bm !== 'object' || typeof hm !== 'object' || hm == null) {
        if (stable(bm) !== stable(hm)) v.push(`${path}: job ${id} matrix changed`);
      } else {
        const have = new Set(matrixLeaves(hm));
        for (const leaf of matrixLeaves(bm)) {
          if (!have.has(leaf)) v.push(`${path}: job ${id} matrix entry removed: ${leaf}`);
        }
        const oldEx = new Set((bm.exclude || []).map(stable));
        for (const ex of hm.exclude || []) {
          if (!oldEx.has(stable(ex)))
            v.push(`${path}: job ${id} matrix excludes more: ${stable(ex)}`);
        }
      }
    }

    const baseSteps = Array.isArray(bj.steps) ? bj.steps : [];
    const headSteps = Array.isArray(hj.steps) ? hj.steps.slice() : [];
    const used = new Set();
    for (const bs of baseSteps) {
      const key = stepId(bs);
      const at = headSteps.findIndex((hs, k) => !used.has(k) && stepId(hs) === key);
      const label = key.replace(/^\w+:/, '').slice(0, 100);
      if (at < 0) {
        v.push(`${path}: job ${id} step removed: ${label}`);
        continue;
      }
      used.add(at);
      const hs = headSteps[at];
      if (!isMap(bs) || !isMap(hs)) continue;
      for (const what of changedControl(bs, hs)) {
        v.push(`${path}: job ${id} step "${label}" has a new or changed ${what}`);
      }
      const old = countBy(linesOf(bs.run).map((l) => l.trim()));
      for (const l of linesOf(hs.run)) {
        const t = l.trim();
        if (old.get(t)) {
          old.set(t, old.get(t) - 1);
        } else if (BYPASS_COMMANDS.some((r) => r.test(t))) {
          v.push(`${path}: job ${id} step "${label}" now ignores failures: ${t.slice(0, 140)}`);
        }
      }
    }
  }
  return v;
}

// --------------------------------------------------------- test checks

// Lines that make a test stop running or stop counting.
const SKIP_MARKERS = [
  /\b(?:it|test|describe|suite)\s*\.\s*(?:skip|only|todo|fixme|fails?|skipIf|runIf)\b/,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /\bskip\s*:\s*(?:true|['"`])/,
  /\btodo\s*:\s*(?:true|['"`])/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail|importorskip)\s*\(/,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
];

// Lines that define a test, and the name each one gives it.
const JS_TEST =
  /^\s*(?:it|test)\s*(?:\.\s*(?:skip|only|todo|fixme|fails?|concurrent|sequential|skipIf\s*\([^)]*\)|runIf\s*\([^)]*\)|each\s*\([^)]*\))\s*)?\(\s*(?:(['"`])((?:\\.|(?!\1).)*)\1)?/;
const PY_TEST = /^\s*(?:async\s+)?def\s+(test_\w*)\s*\(/;

export function testName(line) {
  const py = PY_TEST.exec(line);
  if (py) return `def ${py[1]}`;
  const js = JS_TEST.exec(line);
  if (js) return js[2] != null ? `test ${js[2]}` : `test ${line.trim()}`;
  return null;
}

// Lines that check a result.
const ASSERTIONS = [
  /\bexpect(?:\.\w+)*\s*\(/,
  /\bassert(?:\.\w+|_\w+|[A-Z]\w*)?\s*\(/,
  /^\s*assert\s/,
  /\bpytest\.raises\s*\(/,
];

const isComment = (line) => /^\s*(?:#|\/\/|\/\*|\*)/.test(line);
const normalize = (line) => line.trim().replace(/\s+/g, ' ');

export function checkTests(removed, added) {
  // removed / added: code lines taken out of and put into the test files.
  const v = [];
  const live = (lines) => lines.filter((l) => !isComment(l));

  const gone = countBy(live(removed).map(testName).filter(Boolean));
  const now = countBy(live(added).map(testName).filter(Boolean));
  // Fewer tests than before across all changed files (moving, renaming or
  // replacing a test keeps the count). The names show which ones went.
  const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  if (total(gone) > total(now)) {
    const lost = [];
    for (const [name, n] of gone) {
      const missing = n - (now.get(name) || 0);
      for (let k = 0; k < missing; k++) lost.push(name.slice(0, 120));
    }
    v.push(
      `Fewer tests than before: ${total(gone)} test definitions removed, ${total(now)} added` +
        ` (${lost.slice(0, 20).join('; ')}${lost.length > 20 ? '; ...' : ''}).`,
    );
  }

  const isMarker = (l) => SKIP_MARKERS.some((r) => r.test(l));
  const oldMarkers = countBy(live(removed).filter(isMarker).map(normalize));
  for (const l of live(added).filter(isMarker)) {
    const t = normalize(l);
    if (oldMarkers.get(t)) oldMarkers.set(t, oldMarkers.get(t) - 1);
    else v.push(`Skip or only marker added: ${t.slice(0, 140)}`);
  }

  const isAssert = (l) => ASSERTIONS.some((r) => r.test(l));
  const lessAsserts = live(removed).filter(isAssert).length;
  const moreAsserts = live(added).filter(isAssert).length;
  if (lessAsserts > moreAsserts) {
    v.push(
      `Fewer assertions than before: ${lessAsserts} assertion lines removed, ${moreAsserts} added.`,
    );
  }
  return v;
}

// ------------------------------------------------------------------ run

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function show(commit, path) {
  try {
    return git(['show', `${commit}:${path}`]);
  } catch {
    return null;
  }
}

function diffLines(diff) {
  const removed = [];
  const added = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { removed, added };
}

export function runGuard(base) {
  // Read the rules from the base commit, so a pull request cannot loosen
  // them for itself. When the base has no rules, this pull request is the
  // one that installs the guard, so it passes.
  const configText = show(base, '.github/test-guard.json');
  if (configText == null) return { installing: true, violations: [] };
  const config = JSON.parse(configText);
  const isUnguarded = matcher(config.unguarded);
  const isGuard = matcher(config.guard);
  const isWorkflow = matcher(config.workflows);
  const isProtected = matcher(config.protected);
  const isFixture = matcher(config.fixtures);
  const isTest = matcher(config.tests);

  const range = `${base}...HEAD`;
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const changes = git(['diff', '--name-status', '-M', range])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      return { status: parts[0][0], from: parts[1], to: parts[2] || parts[1] };
    });

  const baseChecks = new Set();
  for (const path of git(['ls-tree', '-r', '--name-only', mergeBase]).split('\n')) {
    if (!isWorkflow(path) && !isGuard(path)) continue;
    try {
      const wf = parseYaml(show(mergeBase, path) || '');
      for (const [id, job] of Object.entries(wf?.jobs || {})) baseChecks.add(checkName(id, job));
    } catch {
      // An unreadable base workflow contributes no names.
    }
  }

  const violations = [];
  const removed = [];
  const added = [];

  for (const { status, from, to } of changes) {
    const paths = status === 'R' ? [from, to] : [to];
    const fileDiff = () =>
      diffLines(
        git(
          status === 'R'
            ? ['diff', '-U0', '-M', range, '--', from, to]
            : ['diff', '-U0', range, '--', to],
        ),
      );

    // Guard, workflow and protected files: the first rule that matches wins.
    for (const path of paths) {
      if (isUnguarded(path)) {
        // Not a test, check or stored answer (for example Dependabot's settings).
      } else if (isGuard(path)) {
        violations.push(`Test guard file changed (${status}): ${path}`);
      } else if (isWorkflow(path)) {
        if (status === 'D' || (status === 'R' && path === from && !isWorkflow(to))) {
          violations.push(`Workflow deleted (${status}): ${path}`);
        } else if (path === to) {
          const baseText = show(mergeBase, from);
          const headText = show('HEAD', to);
          violations.push(...checkWorkflow(to, baseText, headText, fileDiff().added, baseChecks));
        }
      } else if (isProtected(path)) {
        violations.push(`Protected file changed (${status}): ${path}`);
      } else if (isFixture(path) && !path.endsWith('.md') && (status !== 'A' || path !== to)) {
        if (!(status === 'R' && path === to)) {
          violations.push(`Stored answer changed (${status}): ${path}`);
        }
      }
    }

    if (status === 'D' && isTest(from)) {
      violations.push(`Test file deleted: ${from}`);
      const old = show(mergeBase, from) || '';
      removed.push(...old.split('\n'));
      continue;
    }
    if (status === 'R' && isTest(from) && !isTest(to)) {
      violations.push(`Test file moved out of the test folders: ${from} -> ${to}`);
    }
    if (!isTest(to)) continue;
    const d = fileDiff();
    removed.push(...d.removed);
    added.push(...d.added);
  }

  violations.push(...checkTests(removed, added));
  return { installing: false, violations };
}

function readLabels() {
  if (!process.env.GITHUB_EVENT_PATH) return [];
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    return (event.pull_request?.labels || []).map((l) => l.name);
  } catch {
    return []; // No event file: treat as unapproved.
  }
}

function main() {
  const base = process.argv[2] || process.env.GUARD_BASE;
  if (!base) {
    console.error('test-guard: pass the base commit as the first argument.');
    process.exit(2);
  }
  const { installing, violations } = runGuard(base);
  if (installing) {
    console.log(
      'test-guard: the base commit has no guard yet, so this pull request is installing it. Passing.',
    );
    process.exit(0);
  }
  if (violations.length === 0) {
    console.log('test-guard: no test, evaluation or check weakening found.');
    process.exit(0);
  }

  console.log('test-guard found changes that can weaken testing:');
  for (const v of violations) console.log(`  - ${v}`);

  if (readLabels().includes(APPROVAL_LABEL)) {
    console.log(`\nApproved by the "${APPROVAL_LABEL}" label. Passing.`);
    process.exit(0);
  }
  console.log(
    `\nThe owner must review these and add the "${APPROVAL_LABEL}" label to this pull request.` +
      '\nCoding agents must never add that label themselves.',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
