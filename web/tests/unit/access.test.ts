import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ROLES,
  can,
  capabilitiesFor,
  parseCapability,
  parseRole,
  type Capability,
  type Role,
} from '@/lib/access';

// The matrix in docs/access/roles.md (docs/ACCESS.md lists it) is the owner-approved intent. The table is read from that file here,
// so a change to either side without the other fails this test.
const ACCESS_DOC = fileURLToPath(new URL('../../../docs/access/roles.md', import.meta.url));
const ROLE_COLUMNS: Role[] = ['owner', 'estimator', 'office'];
const PRICE_KEYS = ['prices_read', 'prices_manage'];

function docMatrix(): Map<string, Record<Role, boolean>> {
  const text = readFileSync(ACCESS_DOC, 'utf8');
  const start = text.indexOf('## Company roles');
  const end = text.indexOf('\n## ', start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  const rows = new Map<string, Record<Role, boolean>>();
  for (const line of text.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const key = /^`([a-z_]+)`$/.exec(cells[1] ?? '')?.[1];
    if (!key) continue;
    const marks = cells.slice(-4, -1);
    expect(marks, `row ${key}`).toHaveLength(3);
    expect(
      marks.every((m) => m === 'yes' || m === 'no'),
      `row ${key}`,
    ).toBe(true);
    const [owner, estimator, office] = marks.map((m) => m === 'yes');
    rows.set(key, { owner: !!owner, estimator: !!estimator, office: !!office });
  }
  return rows;
}

const on = { priceBooks: true };
const off = { priceBooks: false };

describe('access table against docs/access/roles.md', () => {
  const matrix = docMatrix();

  it('lists exactly 25 keys in the document, and the table knows the same keys', () => {
    expect(matrix.size).toBe(25);
    expect([...CAPABILITIES].sort()).toEqual([...matrix.keys()].sort());
  });

  it.each(ROLE_COLUMNS)('gives %s exactly the keys the document marks yes (price flag on)', (role) => {
    const expected = [...matrix].filter(([, who]) => who[role]).map(([key]) => key);
    expect([...capabilitiesFor(role, on)].sort()).toEqual(expected.sort());
  });

  it.each(ROLE_COLUMNS)('answers can() for every key like the document does for %s', (role) => {
    for (const [key, who] of matrix) {
      expect(can(role, key, on), `${role} ${key}`).toBe(who[role]);
    }
  });

  it('has the roles the document has and no others', () => {
    expect([...ROLES]).toEqual(ROLE_COLUMNS);
  });
});

describe('price flag', () => {
  it.each(ROLE_COLUMNS)('removes prices_read and prices_manage from %s when off', (role) => {
    const keys = capabilitiesFor(role, off);
    for (const key of PRICE_KEYS) {
      expect(keys).not.toContain(key);
      expect(can(role, key, off)).toBe(false);
    }
  });

  it('leaves the other 21 keys unchanged when off', () => {
    const matrix = docMatrix();
    for (const role of ROLE_COLUMNS) {
      const expected = [...matrix]
        .filter(([key, who]) => who[role] && !PRICE_KEYS.includes(key))
        .map(([key]) => key);
      expect([...capabilitiesFor(role, off)].sort()).toEqual(expected.sort());
    }
  });

  it('treats anything but the boolean true as off', () => {
    for (const bad of [undefined, null, 'true', 1, {}]) {
      const flags = { priceBooks: bad } as unknown as { priceBooks: boolean };
      expect(can('owner', 'prices_read', flags)).toBe(false);
      expect(capabilitiesFor('owner', flags)).not.toContain('prices_manage');
    }
  });

  it('lists the price keys only in the table that includes them', () => {
    expect(CAPABILITIES).toContain('prices_read');
    expect(CAPABILITIES).toContain('prices_manage');
    expect(CAPABILITIES).toHaveLength(25);
  });
});

describe('refusals', () => {
  it.each([
    'superadmin',
    'Owner',
    ' owner',
    '',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
  ])('refuses the unknown role %j', (role) => {
    expect(capabilitiesFor(role, on)).toEqual([]);
    expect(can(role, 'jobs_read', on)).toBe(false);
    expect(() => parseRole(role)).toThrow();
  });

  it.each([undefined, null, 0, 42, true, {}, [], ['owner']])('refuses a non-string role %j', (role) => {
    expect(capabilitiesFor(role, on)).toEqual([]);
    expect(can(role, 'jobs_read', on)).toBe(false);
    expect(() => parseRole(role)).toThrow();
  });

  it.each(['jobs_delete', 'JOBS_READ', 'jobs_read ', '', 'constructor', '__proto__', 'length'])(
    'refuses the unknown key %j for every role',
    (key) => {
      for (const role of ROLES) expect(can(role, key, on)).toBe(false);
      expect(() => parseCapability(key)).toThrow();
    },
  );

  it.each([undefined, null, 7, {}, ['jobs_read']])('refuses a non-string key %j', (key) => {
    expect(can('owner', key, on)).toBe(false);
    expect(() => parseCapability(key)).toThrow();
  });

  it('accepts every known role and key through the parsers', () => {
    for (const role of ROLES) expect(parseRole(role)).toBe(role);
    for (const key of CAPABILITIES) expect(parseCapability(key)).toBe(key);
  });
});

describe('table integrity', () => {
  it('returns a list a caller cannot use to change the table', () => {
    const keys = capabilitiesFor('office', on) as Capability[];
    expect(() => keys.push('sign')).toThrow();
    expect(can('office', 'sign', on)).toBe(false);
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(ROLES)).toBe(true);
  });

  it('gives each role a list with no repeated key', () => {
    for (const role of ROLES) {
      const keys = capabilitiesFor(role, on);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
