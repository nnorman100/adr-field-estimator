import { describe, expect, it, vi } from 'vitest';
import {
  API,
  parseArgs,
  releaseName,
  releaseRules,
  type RulesOptions,
} from '../../scripts/release-rules';

const RELEASE = 'projects/dryscope/releases/cloud.firestore/dryscope-field-test';
const OLD = 'projects/dryscope/rulesets/0000-old';
const NEW = 'projects/dryscope/rulesets/1111-new';
const SOURCE =
  "rules_version = '2';\nservice cloud.firestore { match /{d=**} { allow read, write: if false; } }\n";

type Answer = { status: number; body?: unknown };

// A fake Rules API: each "METHOD path" answers from its own queue; anything unlisted is a 500.
function fakeApi(answers: Record<string, Answer[]>) {
  const seen: Array<{ call: string; body: unknown; auth: string | null }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = `${init?.method} ${String(url).slice(API.length + 1)}`;
    const headers = new Headers(init?.headers);
    seen.push({
      call,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      auth: headers.get('authorization'),
    });
    const answer = answers[call]?.shift() ?? {
      status: 500,
      body: { error: { message: `unexpected ${call}` } },
    };
    return Response.json(answer.body ?? {}, { status: answer.status });
  });
  return { fn: fn as unknown as typeof fetch, seen };
}

const options = (f: typeof fetch, source = SOURCE): RulesOptions => ({
  env: 'test',
  source,
  token: 'ya29.token',
  fetch: f,
});

const released = (ruleset: string) => ({
  status: 200,
  body: { name: RELEASE, rulesetName: ruleset },
});
const rulesetOf = (content: string) => ({
  status: 200,
  body: { name: OLD, source: { files: [{ name: 'firestore.rules', content }] } },
});

describe('the field-database rules release', () => {
  it('targets only the test field database', () => {
    expect(releaseName('test')).toBe(RELEASE);
    expect(parseArgs(['--env', 'test', '--file', 'firestore.rules'])).toEqual({
      env: 'test',
      file: 'firestore.rules',
    });
    expect(() => parseArgs(['--env', 'live', '--file', 'firestore.rules'])).toThrow(
      '--env must be test',
    );
    expect(() => parseArgs(['--env', 'test'])).toThrow('--file is required');
  });

  it('creates nothing when the release already enforces the same file', async () => {
    const { fn, seen } = fakeApi({
      [`GET ${RELEASE}`]: [released(OLD)],
      [`GET ${OLD}`]: [rulesetOf(SOURCE)],
    });
    expect(await releaseRules(options(fn))).toEqual({
      changed: false,
      release: RELEASE,
      ruleset: OLD,
    });
    expect(seen.map((s) => s.call)).toEqual([`GET ${RELEASE}`, `GET ${OLD}`]);
    expect(seen.every((s) => s.auth === 'Bearer ya29.token')).toBe(true);
  });

  it('creates a ruleset from the file and points the existing release at it', async () => {
    const { fn, seen } = fakeApi({
      [`GET ${RELEASE}`]: [released(OLD), released(NEW)],
      [`GET ${OLD}`]: [rulesetOf('an older file')],
      'POST projects/dryscope/rulesets': [{ status: 200, body: { name: NEW } }],
      [`PATCH ${RELEASE}`]: [released(NEW)],
      [`GET ${NEW}`]: [rulesetOf(SOURCE)],
    });
    const lines: string[] = [];
    expect(await releaseRules(options(fn), (l) => lines.push(l))).toEqual({
      changed: true,
      release: RELEASE,
      ruleset: NEW,
    });
    expect(seen.map((s) => s.call)).toEqual([
      `GET ${RELEASE}`,
      `GET ${OLD}`,
      'POST projects/dryscope/rulesets',
      `PATCH ${RELEASE}`,
      `GET ${RELEASE}`,
      `GET ${NEW}`,
    ]);
    expect(seen[2]?.body).toEqual({
      source: { files: [{ name: 'firestore.rules', content: SOURCE }] },
    });
    expect(seen[3]?.body).toEqual({
      release: { name: RELEASE, rulesetName: NEW },
      updateMask: 'rulesetName',
    });
    expect(lines.join('\n')).not.toContain('ya29');
  });

  it('creates the release the first time', async () => {
    const { fn, seen } = fakeApi({
      [`GET ${RELEASE}`]: [
        { status: 404, body: { error: { message: 'not found' } } },
        released(NEW),
      ],
      'POST projects/dryscope/rulesets': [{ status: 200, body: { name: NEW } }],
      'POST projects/dryscope/releases': [released(NEW)],
      [`GET ${NEW}`]: [rulesetOf(SOURCE)],
    });
    expect((await releaseRules(options(fn))).changed).toBe(true);
    expect(seen.map((s) => s.call)).toEqual([
      `GET ${RELEASE}`,
      'POST projects/dryscope/rulesets',
      'POST projects/dryscope/releases',
      `GET ${RELEASE}`,
      `GET ${NEW}`,
    ]);
    expect(seen[2]?.body).toEqual({ name: RELEASE, rulesetName: NEW });
  });

  it('changes nothing the database enforces when the rules do not compile', async () => {
    const { fn, seen } = fakeApi({
      [`GET ${RELEASE}`]: [released(OLD)],
      [`GET ${OLD}`]: [rulesetOf('an older file')],
      'POST projects/dryscope/rulesets': [
        { status: 400, body: { error: { message: 'Compilation errors in firestore.rules' } } },
      ],
    });
    await expect(releaseRules(options(fn))).rejects.toThrow(
      'creating the ruleset: status 400: Compilation errors',
    );
    expect(seen.map((s) => s.call)).not.toContain(`PATCH ${RELEASE}`);
  });

  it('stops on a refused read instead of guessing there is no release', async () => {
    const { fn, seen } = fakeApi({
      [`GET ${RELEASE}`]: [
        { status: 403, body: { error: { message: 'firebaserules.releases.get denied' } } },
      ],
    });
    await expect(releaseRules(options(fn))).rejects.toThrow(`reading ${RELEASE}: status 403`);
    expect(seen).toHaveLength(1);
  });

  it('fails when the release read back does not name the new ruleset', async () => {
    const { fn } = fakeApi({
      [`GET ${RELEASE}`]: [released(OLD), released(OLD)],
      [`GET ${OLD}`]: [rulesetOf('an older file')],
      'POST projects/dryscope/rulesets': [{ status: 200, body: { name: NEW } }],
      [`PATCH ${RELEASE}`]: [released(NEW)],
    });
    await expect(releaseRules(options(fn))).rejects.toThrow(`does not name ${NEW}`);
  });

  it('fails when the ruleset read back is not the committed file', async () => {
    const { fn } = fakeApi({
      [`GET ${RELEASE}`]: [released(OLD), released(NEW)],
      [`GET ${OLD}`]: [rulesetOf('an older file')],
      'POST projects/dryscope/rulesets': [{ status: 200, body: { name: NEW } }],
      [`PATCH ${RELEASE}`]: [released(NEW)],
      [`GET ${NEW}`]: [rulesetOf(`${SOURCE}// edited\n`)],
    });
    await expect(releaseRules(options(fn))).rejects.toThrow(
      `${NEW} does not hold the committed rules file`,
    );
  });

  it('refuses a missing token or an empty file before calling the API', async () => {
    const { fn, seen } = fakeApi({});
    await expect(releaseRules({ ...options(fn), token: '' })).rejects.toThrow('no access token');
    await expect(releaseRules(options(fn, '  \n'))).rejects.toThrow('the rules file is empty');
    expect(seen).toHaveLength(0);
  });

  it('never calls a delete, a list or another release', async () => {
    const { fn, seen } = fakeApi({
      [`GET ${RELEASE}`]: [released(OLD), released(NEW)],
      [`GET ${OLD}`]: [rulesetOf('an older file')],
      'POST projects/dryscope/rulesets': [{ status: 200, body: { name: NEW } }],
      [`PATCH ${RELEASE}`]: [released(NEW)],
      [`GET ${NEW}`]: [rulesetOf(SOURCE)],
    });
    expect((await releaseRules(options(fn))).changed).toBe(true);
    for (const { call } of seen) {
      expect(call).not.toMatch(/^DELETE /);
      expect(call).not.toContain('dryscope-field-live');
      expect(call.split(' ')[1]).toMatch(/^projects\/dryscope\/(rulesets|releases)/);
    }
  });
});
