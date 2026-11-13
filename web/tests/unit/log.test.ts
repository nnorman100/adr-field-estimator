import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log, traceFields } from '@/lib/log';

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'dryscope-test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('log', () => {
  it('writes one JSON line with severity and message', () => {
    log('WARNING', 'rate limit reached', { component: 'api', status: 429 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(lines[0]!.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      severity: 'WARNING',
      message: 'rate limit reached',
      component: 'api',
      status: 429,
    });
  });

  it('drops a field that is not on the allowlist', () => {
    log('INFO', 'x', { component: 'api', body: 'secret', headers: { authorization: 'x' } } as never);
    expect(Object.keys(JSON.parse(lines[0]!)).sort()).toEqual(['component', 'message', 'severity']);
  });

  it('adds the trace and span from a traceparent header', () => {
    const headers = new Headers({ traceparent: `00-${TRACE}-${SPAN}-01` });
    log('INFO', 'x', {}, headers);
    const line = JSON.parse(lines[0]!);
    expect(line['logging.googleapis.com/trace']).toBe(`projects/dryscope-test/traces/${TRACE}`);
    expect(line['logging.googleapis.com/spanId']).toBe(SPAN);
    expect(line['logging.googleapis.com/trace_sampled']).toBe(true);
  });

  it('adds the trace and span from an X-Cloud-Trace-Context header (span in decimal)', () => {
    expect(traceFields(new Headers({ 'x-cloud-trace-context': `${TRACE}/74;o=0` }))).toEqual({
      'logging.googleapis.com/trace': `projects/dryscope-test/traces/${TRACE}`,
      'logging.googleapis.com/spanId': '000000000000004a',
      'logging.googleapis.com/trace_sampled': false,
    });
  });

  it('prefers traceparent over X-Cloud-Trace-Context', () => {
    const other = 'a'.repeat(32);
    const found = traceFields({ traceparent: `00-${TRACE}-${SPAN}-00`, 'x-cloud-trace-context': `${other}/1;o=1` });
    expect(found['logging.googleapis.com/trace']).toBe(`projects/dryscope-test/traces/${TRACE}`);
  });

  it('adds no trace field for a malformed header, an all-zero trace, or no project', () => {
    expect(traceFields(new Headers({ traceparent: 'garbage' }))).toEqual({});
    expect(traceFields(new Headers({ traceparent: `00-${'0'.repeat(32)}-${SPAN}-01` }))).toEqual({});
    expect(traceFields(new Headers({ 'x-cloud-trace-context': 'x/y;o=1' }))).toEqual({});
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    expect(traceFields(new Headers({ traceparent: `00-${TRACE}-${SPAN}-01` }))).toEqual({});
  });

  it('keeps an email, a bearer token and a coordinate pair out of a message or a field', () => {
    log('ERROR', 'failed for jo@example.com with Bearer abc.def.ghi at 34.0522, -118.2437', {
      code: 'jo@example.com',
      route: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
    });
    expect(lines[0]).not.toMatch(/jo@example\.com|abc\.def\.ghi|eyJhbGci|34\.0522|118\.2437/);
  });
});
