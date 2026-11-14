import { describe, expect, it, vi } from 'vitest';
import { tenantBody } from '../../scripts/create-tenant';
import { parseSecureArgs, secureTenants, tenantChange } from '../../scripts/secure-tenants';

// The owner-run command that brings tenants made before 2026-11-14 up to the sign-in settings the
// tenant command now sets (owner decision 2026-11-14, sign-in security review F1 and F2): a
// password rule of at least 12 characters, enforced, and email enumeration protection. It reads
// first and changes nothing unless the owner adds --apply. Google is replaced at fetch.

const STRONG = {
  passwordPolicyEnforcementState: 'ENFORCE',
  forceUpgradeOnSignin: true,
  passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12 }, schemaVersion: 1 }],
};
const tenant = (id: string, extra: Record<string, unknown> = {}) => ({
  name: `projects/dryscope/tenants/${id}`,
  displayName: id.replace(/-[a-z0-9]{5}$/, ''),
  ...extra,
});
const secured = (id: string) => tenant(id, { passwordPolicyConfig: STRONG, emailPrivacyConfig: { enableImprovedEmailPrivacy: true } });

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

// A fake Identity Toolkit: lists the given tenants in pages of `pageSize`, and answers a PATCH
// with the tenant as changed (or as `afterPatch` returns it).
function google(tenants: Record<string, unknown>[], options: { pageSize?: number; failList?: number; failPatch?: number; afterPatch?: (t: Record<string, unknown>) => Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const pageSize = options.pageSize ?? 1000;
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const parsed = new URL(url);
    if (method === 'GET') {
      if (options.failList) return new Response('{"error":{"message":"detail with a token ya29.secret"}}', { status: options.failList });
      const start = Number(parsed.searchParams.get('pageToken') ?? '0');
      const page = tenants.slice(start, start + pageSize);
      const next = start + pageSize < tenants.length ? String(start + pageSize) : undefined;
      return Response.json({ tenants: page, ...(next ? { nextPageToken: next } : {}) });
    }
    if (options.failPatch) return new Response('{"error":{"message":"detail"}}', { status: options.failPatch });
    const id = parsed.pathname.split('/').pop();
    const current = tenants.find((t) => t.name === `projects/dryscope/tenants/${id}`)!;
    const changed = { ...current, ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
    return Response.json(options.afterPatch ? options.afterPatch(changed) : changed);
  });
  return { calls, deps: { accessToken: async () => 'ya29.owner-token', fetch: fetch as unknown as typeof globalThis.fetch } };
}

function run(tenants: Record<string, unknown>[], argv: string[], options: Parameters<typeof google>[1] = {}) {
  const fake = google(tenants, options);
  const lines: string[] = [];
  const result = secureTenants(parseSecureArgs(argv), { ...fake.deps, log: (line) => lines.push(line) });
  return { result, lines, calls: fake.calls };
}

describe('parseSecureArgs', () => {
  it('reads first by default, and changes only with --apply', () => {
    expect(parseSecureArgs(['--project', 'dryscope'])).toEqual({ project: 'dryscope', tenants: [], apply: false });
    expect(parseSecureArgs(['--project', 'dryscope', '--apply'])).toEqual({ project: 'dryscope', tenants: [], apply: true });
    expect(parseSecureArgs(['--project', 'dryscope', '--tenant', 'company-a-x1y2z', '--tenant', 'ops-a1b2c'])).toEqual({
      project: 'dryscope',
      tenants: ['company-a-x1y2z', 'ops-a1b2c'],
      apply: false,
    });
  });

  it('refuses a missing or malformed project or tenant, and anything it does not know', () => {
    expect(() => parseSecureArgs([])).toThrow(/--project is required/);
    expect(() => parseSecureArgs(['--project', 'Dry Scope'])).toThrow(/--project/);
    expect(() => parseSecureArgs(['--project', 'dryscope', '--tenant'])).toThrow(/--tenant/);
    expect(() => parseSecureArgs(['--project', 'dryscope', '--tenant', 'a/b'])).toThrow(/--tenant/);
    expect(() => parseSecureArgs(['--project', 'dryscope', '--yes'])).toThrow(/unknown option --yes/);
    expect(() => parseSecureArgs(['--project', 'dryscope', 'apply'])).toThrow(/unexpected argument/);
  });
});

describe('tenantChange', () => {
  it('sets both settings on a tenant made without them', () => {
    expect(tenantChange(tenant('company-a-x1y2z'))).toEqual({
      tenantId: 'company-a-x1y2z',
      displayName: 'company-a',
      changes: [
        'password rule: none -> at least 12 characters, enforced, old passwords changed at next sign-in',
        'email enumeration protection: off -> on',
      ],
      updateMask: ['passwordPolicyConfig', 'emailPrivacyConfig'],
      body: {
        passwordPolicyConfig: {
          passwordPolicyEnforcementState: 'ENFORCE',
          forceUpgradeOnSignin: true,
          passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12 } }],
        },
        emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
      },
    });
  });

  it('leaves a tenant alone when it already has both, including one the tenant command makes now', () => {
    expect(tenantChange(secured('company-a-x1y2z'))).toBeNull();
    expect(tenantChange({ name: 'projects/dryscope/tenants/new-a1b2c', ...tenantBody('new') })).toBeNull();
  });

  it('never weakens a stronger rule: it keeps longer minimums and the other requirements', () => {
    const stronger = {
      passwordPolicyEnforcementState: 'ENFORCE',
      forceUpgradeOnSignin: true,
      passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 16, containsNumericCharacter: true } }],
    };
    const change = tenantChange(tenant('company-a-x1y2z', { passwordPolicyConfig: stronger }));
    expect(change?.updateMask).toEqual(['emailPrivacyConfig']);
    expect(change?.body).toEqual({ emailPrivacyConfig: { enableImprovedEmailPrivacy: true } });

    const offButLong = { ...stronger, passwordPolicyEnforcementState: 'OFF' };
    expect(tenantChange(tenant('company-a-x1y2z', { passwordPolicyConfig: offButLong, emailPrivacyConfig: { enableImprovedEmailPrivacy: true } }))).toMatchObject({
      changes: ['password rule: off, at least 16 characters -> at least 16 characters, enforced, old passwords changed at next sign-in'],
      updateMask: ['passwordPolicyConfig'],
      body: {
        passwordPolicyConfig: {
          passwordPolicyEnforcementState: 'ENFORCE',
          forceUpgradeOnSignin: true,
          passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 16, containsNumericCharacter: true } }],
        },
      },
    });
  });

  it.each([
    ['a shorter minimum', { ...STRONG, passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 8 } }] }, 'enforced, at least 8 characters'],
    ['no forced change of old passwords', { ...STRONG, forceUpgradeOnSignin: false }, 'enforced, at least 12 characters, old passwords kept'],
    ['enforcement off', { ...STRONG, passwordPolicyEnforcementState: 'OFF' }, 'off, at least 12 characters'],
    ['no strength options', { passwordPolicyEnforcementState: 'ENFORCE', forceUpgradeOnSignin: true }, 'enforced, at least 6 characters'],
  ])('raises a rule with %s to the 12-character rule', (_name, passwordPolicyConfig, before) => {
    const change = tenantChange(tenant('company-a-x1y2z', { passwordPolicyConfig, emailPrivacyConfig: { enableImprovedEmailPrivacy: true } }));
    expect(change?.changes).toEqual([`password rule: ${before} -> at least 12 characters, enforced, old passwords changed at next sign-in`]);
    expect(change?.updateMask).toEqual(['passwordPolicyConfig']);
    expect(change?.body.passwordPolicyConfig?.passwordPolicyVersions).toEqual([{ customStrengthOptions: { minPasswordLength: 12 } }]);
  });

  it('drops a maximum length below the new minimum, which Google would refuse', () => {
    const short = { ...STRONG, passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 6, maxPasswordLength: 10 } }] };
    const change = tenantChange(tenant('company-a-x1y2z', { passwordPolicyConfig: short }));
    expect(change?.body.passwordPolicyConfig?.passwordPolicyVersions).toEqual([{ customStrengthOptions: { minPasswordLength: 12 } }]);
  });

  it('refuses a tenant it cannot read rather than guessing', () => {
    expect(() => tenantChange({ displayName: 'no name' })).toThrow(/could not be read/);
    expect(() => tenantChange({ name: 'projects/dryscope/tenants/../x' })).toThrow(/could not be read/);
  });
});

describe('secureTenants', () => {
  const tenants = [tenant('operators-a1b2c'), secured('company-a-x1y2z'), tenant('company-b-q9w8e', { emailPrivacyConfig: { enableImprovedEmailPrivacy: true } })];

  it('reads every page and, without --apply, changes nothing and says what it would change', async () => {
    const { result, lines, calls } = run(tenants, ['--project', 'dryscope'], { pageSize: 2 });
    expect(await result).toEqual({ checked: 3, needed: 2, changed: 0 });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'https://identitytoolkit.googleapis.com/v2/projects/dryscope/tenants?pageSize=1000'],
      ['GET', 'https://identitytoolkit.googleapis.com/v2/projects/dryscope/tenants?pageSize=1000&pageToken=2'],
    ]);
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer ya29.owner-token', 'X-Goog-User-Project': 'dryscope' });
    expect(lines).toEqual([
      'tenant operators-a1b2c (operators): would change password rule: none -> at least 12 characters, enforced, old passwords changed at next sign-in',
      'tenant operators-a1b2c (operators): would change email enumeration protection: off -> on',
      'tenant company-a-x1y2z (company-a): already set',
      'tenant company-b-q9w8e (company-b): would change password rule: none -> at least 12 characters, enforced, old passwords changed at next sign-in',
      'dry run: 2 of 3 tenants would change; nothing was changed. Run again with --apply to change them.',
    ]);
    expect(lines.join('\n')).not.toContain('ya29');
  });

  it('with --apply, changes only what is missing, by update mask, and checks what Google kept', async () => {
    const { result, lines, calls } = run(tenants, ['--project', 'dryscope', '--apply']);
    expect(await result).toEqual({ checked: 3, needed: 2, changed: 2 });
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.url)).toEqual([
      'https://identitytoolkit.googleapis.com/v2/projects/dryscope/tenants/operators-a1b2c?updateMask=passwordPolicyConfig%2CemailPrivacyConfig',
      'https://identitytoolkit.googleapis.com/v2/projects/dryscope/tenants/company-b-q9w8e?updateMask=passwordPolicyConfig',
    ]);
    expect(patches[1]!.body).toEqual({
      passwordPolicyConfig: {
        passwordPolicyEnforcementState: 'ENFORCE',
        forceUpgradeOnSignin: true,
        passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12 } }],
      },
    });
    expect(patches[0]!.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Goog-User-Project': 'dryscope' });
    expect(lines.at(-1)).toBe('changed 2 of 3 tenants.');
    expect(lines).toContain('tenant company-b-q9w8e (company-b): changed password rule: none -> at least 12 characters, enforced, old passwords changed at next sign-in');
  });

  it('stops when Google answers a change without the settings', async () => {
    const { result } = run(tenants, ['--project', 'dryscope', '--apply'], { afterPatch: (t) => ({ ...t, emailPrivacyConfig: {} }) });
    await expect(result).rejects.toThrow(/^tenant operators-a1b2c did not keep the new settings$/);
  });

  it('works only on the tenants named, and refuses a name it cannot find before changing anything', async () => {
    const named = run(tenants, ['--project', 'dryscope', '--tenant', 'company-b-q9w8e', '--apply']);
    expect(await named.result).toEqual({ checked: 1, needed: 1, changed: 1 });
    expect(named.calls.filter((c) => c.method === 'PATCH').map((c) => c.url)).toEqual([
      'https://identitytoolkit.googleapis.com/v2/projects/dryscope/tenants/company-b-q9w8e?updateMask=passwordPolicyConfig',
    ]);
    const missing = run(tenants, ['--project', 'dryscope', '--tenant', 'company-b-q9w8e', '--tenant', 'gone-z0z0z', '--apply']);
    await expect(missing.result).rejects.toThrow(/^tenant gone-z0z0z was not found in project dryscope$/);
    expect(missing.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('names only the status when Google refuses, never the answer', async () => {
    await expect(run(tenants, ['--project', 'dryscope'], { failList: 403 }).result).rejects.toThrow(/^listing the tenants failed with status 403$/);
    await expect(run(tenants, ['--project', 'dryscope', '--apply'], { failPatch: 400 }).result).rejects.toThrow(
      /^changing tenant operators-a1b2c failed with status 400$/,
    );
  });
});
