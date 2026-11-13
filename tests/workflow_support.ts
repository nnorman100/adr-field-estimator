// Shared helpers for the TypeScript workflow guards (tests/test_ci_workflows.ts,
// tests/test_web_release_workflow.ts and tests/test_web_images.ts). Ported from the helpers in
// tests/test_ci_config.py and tests/test_web_release_workflow.py with the same behaviour,
// including Python's shlex tokenizer, so each ported assertion matches the same commands.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
export const RELEASE = path.join(WORKFLOWS, 'web-release.yml');
export const WEB = path.join(WORKFLOWS, 'web.yml');

// Workflow YAML is loosely typed data; the tests check its shape as they read it.
export type Data = any;

export function load(file: string): Data {
  return parse(readFileSync(file, 'utf8'));
}

/** Python's str.splitlines(): every line boundary it knows, no trailing empty line. */
export function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function steps(job: Data): Data[] {
  return job.steps ?? [];
}

/** The shell a step runs, without comment lines, so a comment never satisfies a check. */
export function commands(step: Data): string {
  const lines = splitlines(String(step.run ?? '').replaceAll('\\\n', ' ')); // join continuations
  return lines.filter((line) => !line.trim().startsWith('#')).join('\n');
}

/** The one step whose id (or, failing that, name) is key. */
export function step(job: Data, key: string): Data {
  const found = steps(job).filter((s) => (s.id ?? s.name) === key);
  if (found.length !== 1) throw new Error(`expected one step ${key}, found ${found.length}`);
  return found[0];
}

export function allSteps(workflow: Data): Data[] {
  return Object.values(workflow.jobs).flatMap((job) => steps(job));
}

/** Dockerfile instructions with comments dropped and continuation lines joined. */
export function instructions(file: string): string[] {
  const text = readFileSync(file, 'utf8').replace(/\\\n/g, ' ');
  return splitlines(text)
    .map((line) => line.trim().split(/\s+/).filter(Boolean).join(' '))
    .filter((line) => line && !line.startsWith('#'));
}

// --- Python's shlex (posix mode, whitespace_split) ----------------------------------------------

const WORDCHARS =
  'abcdfeghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_' +
  'ßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ';
const PUNCTUATION = '();<>|&';
const WHITESPACE = ' \t\r\n';
const QUOTES = '\'"';

/**
 * A port of CPython's shlex.shlex(text, posix=True) with whitespace_split=True. `punctuation`
 * is punctuation_chars=True (operators become their own tokens) and `comments` keeps '#' as the
 * comment character; shlex.split(text) is both off.
 */
export function shlex(text: string, { punctuation = false, comments = false } = {}): string[] {
  const punct = punctuation ? PUNCTUATION : '';
  const commenters = comments ? '#' : '';
  let wordchars = WORDCHARS;
  if (punctuation) wordchars += '~-./*?=';
  const has = (set: string, ch: string) => ch !== '' && set.includes(ch);
  let position = 0;
  let state: string | null = ' ';
  const pushback: string[] = [];
  const read = () => (position < text.length ? text[position++] : '');
  const readline = () => {
    const end = text.indexOf('\n', position);
    position = end === -1 ? text.length : end + 1;
  };

  function readToken(): string | null {
    let quoted = false;
    let escapedstate = ' ';
    let token = '';
    for (;;) {
      const next = punct && pushback.length ? pushback.pop()! : read();
      if (state === null) {
        token = '';
        break;
      } else if (state === ' ') {
        if (!next) {
          state = null;
          break;
        } else if (has(WHITESPACE, next)) {
          if (token || quoted) break;
        } else if (has(commenters, next)) {
          readline();
        } else if (next === '\\') {
          escapedstate = 'a';
          state = next;
        } else if (has(wordchars, next)) {
          token = next;
          state = 'a';
        } else if (has(punct, next)) {
          token = next;
          state = 'c';
        } else if (has(QUOTES, next)) {
          state = next;
        } else {
          token = next; // whitespace_split
          state = 'a';
        }
      } else if (has(QUOTES, state)) {
        quoted = true;
        if (!next) throw new Error('No closing quotation');
        if (next === state) state = 'a';
        else if (next === '\\' && state === '"') {
          escapedstate = state;
          state = next;
        } else token += next;
      } else if (state === '\\') {
        if (!next) throw new Error('No escaped character');
        // In posix shells, only the quote itself or the escape character may be escaped in quotes.
        if (has(QUOTES, escapedstate) && next !== state && next !== escapedstate) token += state;
        token += next;
        state = escapedstate;
      } else {
        // 'a' (word) or 'c' (punctuation)
        if (!next) {
          state = null;
          break;
        } else if (has(WHITESPACE, next)) {
          state = ' ';
          if (token || quoted) break;
        } else if (has(commenters, next)) {
          readline();
          state = ' ';
          if (token || quoted) break;
        } else if (state === 'c') {
          if (has(punct, next)) token += next;
          else {
            if (!has(WHITESPACE, next)) pushback.push(next);
            state = ' ';
            break;
          }
        } else if (has(QUOTES, next)) {
          state = next;
        } else if (next === '\\') {
          escapedstate = 'a';
          state = next;
        } else if (has(wordchars, next) || !has(punct, next)) {
          token += next; // whitespace_split keeps everything but punctuation in the word
        } else {
          pushback.push(next);
          state = ' ';
          if (token || quoted) break;
        }
      }
    }
    return !quoted && token === '' ? null : token;
  }

  const tokens: string[] = [];
  for (let token = readToken(); token !== null; token = readToken()) tokens.push(token);
  return tokens;
}

const OPERATOR_CHARS = new Set('|&;()<>');
/** Python's set(token) <= set('|&;()<>'), which an empty token also satisfies. */
export const isOperator = (token: string) => [...token].every((ch) => OPERATOR_CHARS.has(ch));

// --- The Actions expression language --------------------------------------------------------------

/** Python truthiness for the values these evaluators see. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '' || value === 0) {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function property(context: Data, token: string): unknown {
  let value = context;
  for (const part of token.split('.')) {
    const isMap = value !== null && typeof value === 'object' && !Array.isArray(value);
    value = isMap && Object.hasOwn(value, part) ? value[part] : null;
  }
  return value;
}

const RELEASE_TOKEN = /^\s*('(?:[^']|'')*'|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][\w.-]*)/;
const LITERALS: Record<string, boolean | null> = { true: true, false: false, null: null };

/**
 * The release tests' evaluator (`evaluate` in tests/test_web_release_workflow.py): string,
 * boolean and null literals, property paths, ==, !=, !, &&, ||, parentheses and status functions
 * given in context, where a missing property is null. && and || return an operand, as in Python.
 */
export function evaluate(expression: string, context: Data): unknown {
  const tokens: string[] = [];
  let rest = expression.trim();
  while (rest) {
    const match = RELEASE_TOKEN.exec(rest);
    if (!match) throw new Error(`unsupported expression: ${rest}`);
    tokens.push(match[1]);
    rest = rest.slice(match[0].length).trim();
  }
  let position = 0;
  const peek = () => (position < tokens.length ? tokens[position] : null);
  const take = (expected?: string) => {
    const token = tokens[position];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`expected ${expected ?? 'a token'}, found ${token}`);
    }
    position += 1;
    return token;
  };
  const either = (): unknown => {
    let value = both();
    while (peek() === '||') {
      take();
      const right = both();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const both = (): unknown => {
    let value = compare();
    while (peek() === '&&') {
      take();
      const right = compare();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const compare = (): unknown => {
    let value = unary();
    while (peek() === '==' || peek() === '!=') {
      const op = take();
      const right = unary();
      value = op === '==' ? value === right : value !== right;
    }
    return value;
  };
  const unary = (): unknown => {
    if (peek() === '!') {
      take();
      return !truthy(unary());
    }
    if (peek() === '(') {
      take();
      const value = either();
      take(')');
      return value;
    }
    const token = take();
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (Object.hasOwn(LITERALS, token)) return LITERALS[token];
    if (peek() === '(') {
      take();
      take(')');
      return context[token]();
    }
    return property(context, token);
  };
  const value = either();
  if (position !== tokens.length) throw new Error(`trailing tokens: ${tokens.slice(position)}`);
  return value;
}

const STEP_TOKEN = /(\|\||&&|==|!=|!|\(|\))|'((?:[^']|'')*)'|([A-Za-z_][\w.-]*)/y;
const STATUS_FUNCTIONS = new Set(['always', 'success', 'failure', 'cancelled']);

/**
 * A step `if:` for the expression subset the CI workflows use (evaluate_step_condition in
 * tests/test_ci_config.py), with Actions' rules: case-insensitive string equality, null equal to
 * '', and an implied success() when no status function is called.
 */
export function evaluateStep(
  condition: string,
  scopeOutputs: Record<string, string>,
  jobFailed: boolean,
): boolean {
  let expr = condition.trim();
  if (expr.startsWith('${{') && expr.endsWith('}}')) expr = expr.slice(3, -2).trim();
  const tokens: [string, string][] = [];
  let pos = 0;
  while (pos < expr.length) {
    if (/\s/.test(expr[pos])) {
      pos += 1;
      continue;
    }
    STEP_TOKEN.lastIndex = pos;
    const match = STEP_TOKEN.exec(expr);
    if (!match) throw new Error(`unsupported expression syntax in ${condition}`);
    const [, op, string, ident] = match;
    if (op) tokens.push(['op', op]);
    else if (string !== undefined) tokens.push(['str', string.replaceAll("''", "'")]);
    else tokens.push(['id', ident]);
    pos = STEP_TOKEN.lastIndex;
  }
  const context = { steps: { scope: { outputs: scopeOutputs } } };
  const called = new Set<string>();
  let index = 0;
  const peek = (): [string | null, string | null] =>
    index < tokens.length ? tokens[index] : [null, null];
  const isToken = (kind: string, value: string) => {
    const [k, v] = peek();
    return k === kind && v === value;
  };
  const take = (expected?: [string, string]) => {
    const token = peek();
    if (token[0] === null) throw new Error(`unexpected end of ${condition}`);
    if (expected && (token[0] !== expected[0] || token[1] !== expected[1])) {
      throw new Error(`expected ${expected} in ${condition}`);
    }
    index += 1;
    return token as [string, string];
  };
  const equal = (left: unknown, right: unknown) => {
    const l = left ?? '';
    const r = right ?? '';
    if (typeof l === 'string' && typeof r === 'string') return l.toLowerCase() === r.toLowerCase();
    return l === r;
  };
  const parseOr = (): unknown => {
    let value = parseAnd();
    while (isToken('op', '||')) {
      take();
      const right = parseAnd();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const parseAnd = (): unknown => {
    let value = parseCompare();
    while (isToken('op', '&&')) {
      take();
      const right = parseCompare();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const parseCompare = (): unknown => {
    let value = parseUnary();
    while (isToken('op', '==') || isToken('op', '!=')) {
      const negate = take()[1] === '!=';
      value = equal(value, parseUnary()) !== negate;
    }
    return value;
  };
  const parseUnary = (): unknown => {
    if (isToken('op', '!')) {
      take();
      return !truthy(parseUnary());
    }
    return parsePrimary();
  };
  const parsePrimary = (): unknown => {
    const [kind, value] = take();
    if (kind === 'op' && value === '(') {
      const inner = parseOr();
      take(['op', ')']);
      return inner;
    }
    if (kind === 'str') return value;
    if (kind !== 'id') throw new Error(`unexpected token ${value} in ${condition}`);
    if (isToken('op', '(')) {
      take();
      take(['op', ')']);
      if (!STATUS_FUNCTIONS.has(value)) throw new Error(`unsupported function ${value}()`);
      called.add(value);
      return { always: true, success: !jobFailed, failure: jobFailed, cancelled: false }[value];
    }
    if (Object.hasOwn(LITERALS, value)) return LITERALS[value];
    return property(context, value);
  };
  let result = truthy(parseOr());
  if (index !== tokens.length) throw new Error(`trailing tokens in ${condition}`);
  if (!called.size) result = result && !jobFailed;
  return result;
}

// --- Running a step's shell -----------------------------------------------------------------------

export type Ran = { status: number | null; stdout: string; stderr: string };

/**
 * Runs a step's shell the way Actions does (bash -eo pipefail), with fake commands that log
 * their arguments and then run a given body.
 */
export class Shell {
  readonly tmp: string;
  readonly bin: string;
  readonly log: string;
  readonly output: string;
  readonly summary: string;

  constructor(tmp = mkdtempSync(path.join(tmpdir(), 'workflow-shell-'))) {
    this.tmp = tmp;
    this.bin = path.join(tmp, 'bin');
    mkdirSync(this.bin);
    this.log = path.join(tmp, 'calls.log');
    this.output = path.join(tmp, 'output');
    this.summary = path.join(tmp, 'summary');
  }

  fake(name: string, body = 'exit 0'): void {
    const file = path.join(this.bin, name);
    writeFileSync(
      file,
      '#!/bin/bash\n' +
        `printf -v args '\\x1f%s' "$@"; printf '%s%s\\n' ${name} "$args" >> '${this.log}'\n` +
        `${body}\n`,
    );
    chmodSync(file, 0o755);
  }

  run(
    script: string,
    env: Record<string, unknown> = {},
    cwd: string = this.tmp,
    interpreter = ['bash', '--noprofile', '--norc', '-eo', 'pipefail'],
  ): Ran {
    const full: Record<string, string> = {
      PATH: `${this.bin}:${process.env.PATH}`,
      HOME: this.tmp,
      GITHUB_OUTPUT: this.output,
      GITHUB_STEP_SUMMARY: this.summary,
    };
    for (const [key, value] of Object.entries(env)) full[key] = String(value);
    const [program, ...args] = interpreter;
    const result = spawnSync(program, [...args, '-c', script], {
      env: full,
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  calls(name?: string): string[][] {
    const lines = existsSync(this.log) ? splitlines(readFileSync(this.log, 'utf8')) : [];
    return lines
      .map((line) => line.split('\x1f'))
      .filter((args) => name === undefined || args[0] === name)
      .map((args) => args.slice(1));
  }

  outputs(): Record<string, string> {
    const lines = existsSync(this.output) ? splitlines(readFileSync(this.output, 'utf8')) : [];
    const found: Record<string, string> = {};
    for (const line of lines) {
      const at = line.indexOf('=');
      if (at < 0) throw new Error(`not a KEY=value output line: ${line}`);
      found[line.slice(0, at)] = line.slice(at + 1);
    }
    return found;
  }
}
