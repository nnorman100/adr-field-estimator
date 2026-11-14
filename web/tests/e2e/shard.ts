// The Playwright shard for a CI run, from E2E_SHARD ("current/total", set per matrix run in
// .github/workflows/web.yml). Unset or empty runs the whole suite, as local runs do; any other
// value that is not a valid shard throws, so a bad value never runs everything or nothing.
export type Shard = { current: number; total: number };

export function parseShard(value: string | undefined): Shard | undefined {
  if (value === undefined || value === '') return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  const shard = match && { current: Number(match[1]), total: Number(match[2]) };
  if (!shard || shard.current > shard.total) {
    throw new Error(`E2E_SHARD must be current/total with 1 <= current <= total, got "${value}"`);
  }
  return shard;
}
