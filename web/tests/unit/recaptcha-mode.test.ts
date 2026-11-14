import { describe, expect, it, vi } from 'vitest';
import { parseRecaptchaArgs, setRecaptchaMode } from '../../scripts/recaptcha-mode';

// TC-6: the owner-run command that sets sign-in reCAPTCHA (Identity Platform bot protection for
// email and password) on one existing tenant, to audit or off. Enforcement waits for TC-13, so the
// command refuses it. It prints only the tenant id and the mode. Google is replaced at fetch.

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

// A fake Identity Toolkit that answers a PATCH with the tenant as Google would return it.
// `resolved` is the project the owner's Google credentials name (their gcloud default project).
function google(options: { status?: number; answer?: (sent: Record<string, unknown>) => unknown; resolved?: string | null } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: sent });
    if (options.status) return new Response('{"error":{"message":"detail with a token ya29.secret"}}', { status: options.status });
    const tenant = {
      name: 'projects/dryscope/tenants/test-company-a-x1y2z',
      displayName: 'test-company-a',
      ...sent,
      recaptchaConfig: {
        ...(sent.recaptchaConfig as Record<string, unknown>),
        recaptchaKeys: [{ key: 'projects/dryscope/keys/6Lc-provisioned-key', type: 'WEB' }],
      },
    };
    return Response.json(options.answer ? options.answer(sent) : tenant);
  });
  const projectId = vi.fn(async () => ('resolved' in options ? options.resolved : 'dryscope'));
  const accessToken = vi.fn(async () => 'ya29.owner-token');
  return { calls, projectId, accessToken, deps: { projectId, accessToken, fetch: fetch as unknown as typeof globalThis.fetch } };
}

async function run(argv: string[], options: Parameters<typeof google>[0] = {}) {
  const fake = google(options);
  const lines: string[] = [];
  const result = setRecaptchaMode(parseRecaptchaArgs(argv), { ...fake.deps, log: (line) => lines.push(line) });
  return { result, lines, calls: fake.calls, projectId: fake.projectId, accessToken: fake.accessToken };
}

const ARGS = ['--project', 'dryscope', '--tenant', 'test-company-a-x1y2z'];
const APPROVED = ['--tenant', 'test-company-a-x1y2z', '--mode', 'audit'];
const TENANT_URL = (project: string) => `https://identitytoolkit.googleapis.com/v2/projects/${project}/tenants/test-company-a-x1y2z`;

describe('parseRecaptchaArgs', () => {
  it('reads the project, the tenant and the mode', () => {
    expect(parseRecaptchaArgs([...ARGS, '--mode', 'audit'])).toEqual({ project: 'dryscope', tenant: 'test-company-a-x1y2z', mode: 'AUDIT' });
    expect(parseRecaptchaArgs(['--mode', 'off', '--tenant', 'ops-1', '--project', 'dryscope'])).toEqual({ project: 'dryscope', tenant: 'ops-1', mode: 'OFF' });
  });

  it('reads the approved invocation, with no --project', () => {
    const options = parseRecaptchaArgs(APPROVED);
    expect(options).toEqual({ tenant: 'test-company-a-x1y2z', mode: 'AUDIT' });
    expect(options.project).toBeUndefined();
  });

  it('refuses enforce until TC-13, whatever its case', () => {
    for (const mode of ['enforce', 'ENFORCE', 'Enforce']) {
      expect(() => parseRecaptchaArgs([...ARGS, '--mode', mode])).toThrow(/^--mode enforce is refused until TC-13/);
    }
  });

  it('refuses any other mode and any missing, unknown or extra argument', () => {
    expect(() => parseRecaptchaArgs([...ARGS, '--mode', 'on'])).toThrow(/--mode must be audit or off/);
    expect(() => parseRecaptchaArgs([...ARGS, '--mode', 'AUDIT'])).toThrow(/--mode must be audit or off/);
    expect(() => parseRecaptchaArgs([...ARGS, '--mode', ''])).toThrow(/--mode needs a value/);
    expect(() => parseRecaptchaArgs(ARGS)).toThrow(/--mode is required/);
    expect(() => parseRecaptchaArgs([...ARGS, '--mode'])).toThrow(/--mode needs a value/);
    expect(() => parseRecaptchaArgs(['--project', 'dryscope', '--mode', 'audit'])).toThrow(/--tenant is required/);
    expect(() => parseRecaptchaArgs(['--project', 'Dry Scope', '--tenant', 'ops-1', '--mode', 'audit'])).toThrow(/--project must be/);
    expect(() => parseRecaptchaArgs(['--project', 'dryscope', '--tenant', 'ops/1', '--mode', 'audit'])).toThrow(/--tenant must be/);
    expect(() => parseRecaptchaArgs(['--project', 'dryscope', '--tenant', '--mode', 'audit'])).toThrow(/--tenant needs a value/);
    expect(() => parseRecaptchaArgs([...ARGS, '--mode', 'audit', '--apply'])).toThrow(/unknown option --apply/);
    expect(() => parseRecaptchaArgs([...ARGS, '--mode', 'audit', 'extra'])).toThrow(/unexpected argument extra/);
    expect(() => parseRecaptchaArgs([...ARGS, '--mode', 'audit', '--mode', 'off'])).toThrow(/--mode is given twice/);
  });
});

describe('setRecaptchaMode', () => {
  it('sends only the email and password reCAPTCHA state for the one tenant, with a mask naming only it', async () => {
    const { result, calls } = await run([...ARGS, '--mode', 'audit']);
    await result;
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe('PATCH');
    const url = new URL(call!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://identitytoolkit.googleapis.com/v2/projects/dryscope/tenants/test-company-a-x1y2z');
    expect([...url.searchParams.entries()]).toEqual([['updateMask', 'recaptchaConfig.emailPasswordEnforcementState']]);
    expect(call!.headers).toMatchObject({ Authorization: 'Bearer ya29.owner-token', 'Content-Type': 'application/json', 'X-Goog-User-Project': 'dryscope' });
    expect(call!.body).toEqual({ recaptchaConfig: { emailPasswordEnforcementState: 'AUDIT' } });
  });

  it('sends the approved invocation to the project the owner\'s credentials name', async () => {
    const { result, calls, lines, projectId } = await run(APPROVED, { resolved: 'dryscope' });
    await result;
    expect(projectId).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe('PATCH');
    expect(`${url.origin}${url.pathname}`).toBe(TENANT_URL('dryscope'));
    expect(calls[0]!.headers).toMatchObject({ 'X-Goog-User-Project': 'dryscope' });
    expect(calls[0]!.body).toEqual({ recaptchaConfig: { emailPasswordEnforcementState: 'AUDIT' } });
    expect(lines).toEqual(['tenant test-company-a-x1y2z: audit']);
  });

  it('uses --project over the project the credentials name', async () => {
    const { result, calls, projectId } = await run(['--project', 'dryscope', ...APPROVED], { resolved: 'other-project-1' });
    await result;
    expect(projectId).not.toHaveBeenCalled();
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(TENANT_URL('dryscope'));
    expect(calls[0]!.headers).toMatchObject({ 'X-Goog-User-Project': 'dryscope' });
  });

  it('fails before asking for a token or calling Google when no project can be found', async () => {
    for (const resolved of [undefined, null, '']) {
      const { result, calls, lines, accessToken } = await run(APPROVED, { resolved });
      await expect(result).rejects.toThrow(/^no Google Cloud project found: set a gcloud default project or pass --project$/);
      expect(accessToken).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(lines).toEqual([]);
    }
  });

  it('refuses a found project that is not a project id', async () => {
    for (const resolved of ['Dry Scope', 'dryscope/tenants/x', '../dryscope']) {
      const { result, calls, lines, accessToken } = await run(APPROVED, { resolved });
      await expect(result).rejects.toThrow(/^the Google Cloud project found is not a project id: pass --project$/);
      expect(accessToken).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(lines).toEqual([]);
    }
  });

  it('turns it off the same way', async () => {
    const { result, calls, lines } = await run([...ARGS, '--mode', 'off']);
    await result;
    expect(calls[0]!.body).toEqual({ recaptchaConfig: { emailPasswordEnforcementState: 'OFF' } });
    expect(lines).toEqual(['tenant test-company-a-x1y2z: off']);
  });

  it('prints only the tenant id and the mode: no token, key, display name or Google answer', async () => {
    const { result, lines } = await run([...ARGS, '--mode', 'audit']);
    await result;
    expect(lines).toEqual(['tenant test-company-a-x1y2z: audit']);
    expect(lines.join('\n')).not.toMatch(/ya29|keys\/|6Lc|test-company-a(?!-x1y2z)|projects\//);
  });

  it('names only the status when Google refuses, and prints nothing', async () => {
    const { result, lines } = await run([...ARGS, '--mode', 'audit'], { status: 403 });
    await expect(result).rejects.toThrow(/^setting reCAPTCHA on tenant test-company-a-x1y2z failed with status 403$/);
    expect(lines).toEqual([]);
  });

  it('fails when the answer does not show the new mode', async () => {
    const kept = await run([...ARGS, '--mode', 'audit'], { answer: () => ({ name: 'projects/dryscope/tenants/test-company-a-x1y2z', recaptchaConfig: { emailPasswordEnforcementState: 'OFF' } }) });
    await expect(kept.result).rejects.toThrow(/^tenant test-company-a-x1y2z did not keep reCAPTCHA mode audit$/);
    expect(kept.lines).toEqual([]);
    const empty = await run([...ARGS, '--mode', 'audit'], { answer: () => ({}) });
    await expect(empty.result).rejects.toThrow(/did not keep reCAPTCHA mode audit/);
    const notJson = google();
    const broken = vi.fn(async () => new Response('not json', { status: 200 }));
    await expect(
      setRecaptchaMode({ project: 'dryscope', tenant: 'ops-1', mode: 'OFF' }, { ...notJson.deps, fetch: broken as unknown as typeof fetch, log: () => {} }),
    ).rejects.toThrow(/^tenant ops-1 did not keep reCAPTCHA mode off$/);
  });

  it('never sends ENFORCE, even when called directly', async () => {
    const fake = google();
    await expect(
      setRecaptchaMode({ project: 'dryscope', tenant: 'ops-1', mode: 'ENFORCE' as never }, { ...fake.deps, log: () => {} }),
    ).rejects.toThrow(/refused until TC-13/);
    expect(fake.calls).toEqual([]);
  });
});
