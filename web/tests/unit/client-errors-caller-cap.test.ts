import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/client-errors/route';
import {
  REPORTS_PER_CALLER_PER_MINUTE,
  callerLimitedReports,
  limitedReports,
  resetClientErrorLimit,
} from '@/lib/client-error-intake';

// F6 of the S3 security review: the instance-wide cap (60 a minute) let one anonymous caller use
// the whole allowance and silence every real phone. Each caller now has a share of its own, keyed
// on the connecting address plus a hash of the user agent (never kept raw), and the instance cap
// stays behind it. Cloud Run appends the connecting address as the LAST X-Forwarded-For entry;
// whatever the caller wrote before it is only a claim.

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'dryscope-test');
  resetClientErrorLimit();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const report = (message = 'x is not a function') => ({
  name: 'TypeError',
  message,
  stack: ['    at fn (app.js:10:20)'],
  route: '/field',
  browser: 'safari',
});

const batch = (count: number) => Array.from({ length: count }, (_, i) => report(`m${i}`));

function send(reports: unknown[], caller: { ip?: string; agent?: string; forwarded?: string }): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const forwarded = caller.forwarded ?? caller.ip;
  if (forwarded !== undefined) headers['x-forwarded-for'] = forwarded;
  if (caller.agent !== undefined) headers['user-agent'] = caller.agent;
  return POST(new Request('http://localhost/api/client-errors', { method: 'POST', headers, body: JSON.stringify({ reports }) }));
}

const accepted = async (res: Response) => ((await res.json()) as { accepted: number }).accepted;
const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('POST /api/client-errors: the per-caller cap', () => {
  it('refuses the report after a caller’s share while another caller still gets through', async () => {
    const flooder = { ip: '203.0.113.7', agent: 'FloodBot/1.0' };
    expect(REPORTS_PER_CALLER_PER_MINUTE).toBeLessThan(60);
    expect(await accepted(await send(batch(REPORTS_PER_CALLER_PER_MINUTE), flooder))).toBe(REPORTS_PER_CALLER_PER_MINUTE);

    lines.length = 0;
    const over = await send(batch(1), flooder);
    expect(over.status).toBe(202); // the sender can do nothing about it, so it is not told to retry
    expect(await accepted(over)).toBe(0);
    expect(callerLimitedReports()).toBe(1);
    expect(limitedReports()).toBe(0); // the instance cap was not what stopped it

    lines.length = 0;
    const other = { ip: '198.51.100.9', agent: 'Mobile Safari' };
    expect(await accepted(await send(batch(REPORTS_PER_CALLER_PER_MINUTE), other))).toBe(REPORTS_PER_CALLER_PER_MINUTE);
    expect(lines).toHaveLength(REPORTS_PER_CALLER_PER_MINUTE);
  });

  it('refused reports use none of the instance allowance, so real phones still fit behind a flood', async () => {
    const flooder = { ip: '203.0.113.7', agent: 'FloodBot/1.0' };
    for (let i = 0; i < 10; i++) await send(batch(20), flooder);
    expect(await accepted(await send(batch(20), { ip: '198.51.100.9', agent: 'A' }))).toBe(20);
    expect(await accepted(await send(batch(20), { ip: '198.51.100.10', agent: 'B' }))).toBe(20);
  });

  it('writes only the part of a batch that fits the caller’s share', async () => {
    const caller = { ip: '203.0.113.7', agent: 'x' };
    await send(batch(15), caller);
    expect(await accepted(await send(batch(10), caller))).toBe(REPORTS_PER_CALLER_PER_MINUTE - 15);
    expect(callerLimitedReports()).toBe(10 - (REPORTS_PER_CALLER_PER_MINUTE - 15));
  });

  it('gives the caller a fresh share in the next minute', async () => {
    const caller = { ip: '203.0.113.7', agent: 'x' };
    await send(batch(REPORTS_PER_CALLER_PER_MINUTE), caller);
    expect(await accepted(await send(batch(1), caller))).toBe(0);
    vi.setSystemTime(new Date('2026-11-14T12:01:01Z'));
    expect(await accepted(await send(batch(1), caller))).toBe(1);
  });

  it('treats the same address with another user agent as another caller', async () => {
    await send(batch(REPORTS_PER_CALLER_PER_MINUTE), { ip: '203.0.113.7', agent: 'one' });
    expect(await accepted(await send(batch(1), { ip: '203.0.113.7', agent: 'two' }))).toBe(1);
  });

  it('keys on the last X-Forwarded-For entry, so an invented first entry buys no new share', async () => {
    await send(batch(REPORTS_PER_CALLER_PER_MINUTE), { forwarded: '1.1.1.1, 203.0.113.7', agent: 'x' });
    expect(await accepted(await send(batch(1), { forwarded: '2.2.2.2, 203.0.113.7', agent: 'x' }))).toBe(0);
    expect(await accepted(await send(batch(1), { forwarded: '2.2.2.2, 203.0.113.8', agent: 'x' }))).toBe(1);
  });

  it('keeps a caller with no usable address under the instance cap only', async () => {
    for (const forwarded of [undefined, '', 'not-an-address', '999.1.1.1']) {
      resetClientErrorLimit();
      const caller = forwarded === undefined ? { agent: 'x' } : { forwarded, agent: 'x' };
      expect(await accepted(await send(batch(20), caller))).toBe(20);
      expect(await accepted(await send(batch(20), caller))).toBe(20);
      expect(callerLimitedReports()).toBe(0);
    }
  });

  it('accepts an IPv6 address', async () => {
    const caller = { ip: '2001:db8::7', agent: 'x' };
    await send(batch(REPORTS_PER_CALLER_PER_MINUTE), caller);
    expect(await accepted(await send(batch(1), caller))).toBe(0);
    expect(callerLimitedReports()).toBe(1);
  });

  it('still holds the instance cap behind it, from many callers together', async () => {
    for (let i = 0; i < 4; i++) await send(batch(20), { ip: `203.0.113.${i + 1}`, agent: 'x' });
    expect(limitedReports()).toBe(20);
    expect(callerLimitedReports()).toBe(0);
  });

  it('does not grow without bound under many different callers', async () => {
    for (let i = 0; i < 12_000; i++) await send([report()], { ip: `10.${i >> 8}.${i & 255}.1`, agent: 'x' });
    // The answers stay correct after the table was trimmed: a caller still gets its own share.
    vi.setSystemTime(new Date('2026-11-14T12:05:00Z'));
    expect(await accepted(await send(batch(20), { ip: '203.0.113.1', agent: 'x' }))).toBe(20);
  });
});

describe('POST /api/client-errors: the line when a caller is capped', () => {
  const caller = { ip: '203.0.113.7', agent: 'Mozilla/5.0 (secret-agent-string)' };

  it('writes one line saying a cap was hit, with no address and no user agent', async () => {
    await send(batch(REPORTS_PER_CALLER_PER_MINUTE), caller);
    lines.length = 0;
    await send(batch(1), caller);
    const capLines = events().filter((e) => e.event === 'caller_cap');
    expect(capLines).toHaveLength(1);
    expect(capLines[0]).toMatchObject({ severity: 'WARNING', component: 'client-errors', event: 'caller_cap' });
    const text = lines.join('');
    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain('secret-agent-string');
    expect(text).not.toMatch(/[0-9a-f]{32}/); // not even the hash of the caller
  });

  it('writes it once a minute however many requests are refused, so a flood is no log flood', async () => {
    await send(batch(REPORTS_PER_CALLER_PER_MINUTE), caller);
    lines.length = 0;
    for (let i = 0; i < 50; i++) await send(batch(1), caller);
    expect(events().filter((e) => e.event === 'caller_cap')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-14T12:01:30Z'));
    lines.length = 0;
    await send(batch(REPORTS_PER_CALLER_PER_MINUTE), caller);
    await send(batch(1), caller);
    expect(events().filter((e) => e.event === 'caller_cap')).toHaveLength(1);
  });

  it('writes no line while nobody is capped', async () => {
    await send(batch(5), caller);
    expect(events().filter((e) => e.event === 'caller_cap')).toHaveLength(0);
  });
});
