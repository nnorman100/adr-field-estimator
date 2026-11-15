import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/client-errors/route';
import { resetClientErrorLimit } from '@/lib/client-error-intake';

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  vi.stubEnv('APP_CHECK_MODE', 'off');
  resetClientErrorLimit();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const documentURL =
  'https://app.example/sign-in/private-company/jobs/private-job/finish?token=private-token';
const legacy = (blocked = 'https://firestore.googleapis.com/private-address?key=private-key') => ({
  'csp-report': {
    'document-uri': documentURL,
    'effective-directive': 'connect-src',
    'blocked-uri': blocked,
    'script-sample': 'private transcript',
    'source-file': 'private-file',
    'original-policy': 'private policy',
  },
});
const modern = () => ({
  type: 'csp-violation',
  url: documentURL,
  body: {
    documentURL,
    effectiveDirective: 'script-src-elem',
    blockedURL: 'inline',
    sample: 'private transcript',
  },
});
const send = (body: unknown, type = 'application/csp-report', ip?: string) =>
  POST(
    new Request('https://app.example/api/client-errors', {
      method: 'POST',
      headers: {
        'content-type': type,
        'user-agent': 'Mozilla/5.0 Safari/605.1',
        ...(ip ? { 'x-forwarded-for': ip } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
const accepted = async (response: Response) =>
  ((await response.json()) as { accepted: number }).accepted;

describe('native CSP reports share the client-error intake', () => {
  it('accepts legacy and Reporting API formats and logs fixed categories only', async () => {
    expect(await accepted(await send(legacy()))).toBe(1);
    expect(await accepted(await send([modern()], 'application/reports+json'))).toBe(1);
    const events = lines.map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      message: 'CspViolation: connect-src firestore',
      context: { httpRequest: { url: '/sign-in/[address]/jobs/[jobId]/finish' } },
      browser: 'safari',
    });
    expect(events[1]).toMatchObject({ message: 'CspViolation: script-src-elem inline' });
    expect(lines.join('')).not.toMatch(
      /private|app\.example|firestore\.googleapis\.com|token=|sample|original-policy/,
    );
  });

  it('never logs attacker-controlled directive names or unknown origins', async () => {
    const body = legacy('https://person-name.example/123-Main-St?secret=abc');
    body['csp-report']['effective-directive'] = 'private directive';
    expect(await accepted(await send(body))).toBe(1);
    expect(JSON.parse(lines[0]!).message).toBe('CspViolation: other external');
    expect(lines.join('')).not.toMatch(/person-name|Main-St|secret|private/);
  });

  it('refuses malformed, oversized and overlong batches before logging', async () => {
    for (const body of [{}, { 'csp-report': {} }, { 'csp-report': { 'document-uri': 7 } }])
      expect((await send(body)).status).toBe(400);
    expect(
      (await send(Array.from({ length: 21 }, modern), 'application/reports+json')).status,
    ).toBe(400);
    expect(
      (await send([modern(), { type: 'deprecation', body: {} }], 'application/reports+json'))
        .status,
    ).toBe(400);
    expect((await send({ ...legacy(), extra: 'x'.repeat(8192) })).status).toBe(413);
    expect(lines).toEqual([]);
  });

  it('counts CSP and JavaScript reports together against the same caller share and instance budget', async () => {
    const js = {
      reports: Array.from({ length: 19 }, () => ({
        name: 'Error',
        message: 'failed',
        stack: [],
        route: '/field',
        browser: 'safari',
      })),
    };
    expect(await accepted(await send(js, 'application/json', '203.0.113.7'))).toBe(19);
    expect(await accepted(await send(legacy(), 'application/csp-report', '203.0.113.7'))).toBe(1);
    expect(await accepted(await send([modern()], 'application/reports+json', '203.0.113.7'))).toBe(
      0,
    );
    expect(
      await accepted(
        await send(Array.from({ length: 20 }, modern), 'application/reports+json', '203.0.113.8'),
      ),
    ).toBe(20);
    expect(
      await accepted(
        await send(Array.from({ length: 20 }, modern), 'application/reports+json', '203.0.113.9'),
      ),
    ).toBe(20);
    expect(await accepted(await send(legacy(), 'application/csp-report', '203.0.113.10'))).toBe(0);
  });
});
