import { describe, expect, it } from 'vitest';
import { parseShard } from '../e2e/shard';

describe('parseShard (E2E_SHARD for playwright.config.ts)', () => {
  it('runs the whole suite when unset or empty', () => {
    expect(parseShard(undefined)).toBeUndefined();
    expect(parseShard('')).toBeUndefined();
  });

  it('parses each shard of a total', () => {
    expect(parseShard('1/2')).toEqual({ current: 1, total: 2 });
    expect(parseShard('2/2')).toEqual({ current: 2, total: 2 });
  });

  it.each(['0/2', '3/2', '1/0', '1', 'a/b', '1/2/3', '-1/2', ' 1/2 '])('refuses %j', (value) => {
    expect(() => parseShard(value)).toThrow(/E2E_SHARD/);
  });
});
