import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPERATOR_ACTIONS, ROLES, can, isCapability } from '@/lib/access';

// The operator-only actions (S8-3 added the first, the records check): the table under
// "Operator-only actions" in docs/access/superadmin.md is the intent, read here so a change to either
// side without the other fails.
const DOC = fileURLToPath(new URL('../../../docs/access/superadmin.md', import.meta.url));

function documented(): string[] {
  const text = readFileSync(DOC, 'utf8');
  const start = text.indexOf('## Operator-only actions');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n## ', start + 1);
  const actions: string[] = [];
  for (const line of text.slice(start, end === -1 ? undefined : end).split('\n')) {
    const action = /^`([a-z_]+)`$/.exec(line.split('|')[1]?.trim() ?? '')?.[1];
    if (action) actions.push(action);
  }
  return actions;
}

describe('operator-only actions', () => {
  it('are the actions the document lists', () => {
    expect([...OPERATOR_ACTIONS].sort()).toEqual(documented().sort());
  });

  it('are not capability keys, so no company role holds one', () => {
    for (const action of OPERATOR_ACTIONS) {
      expect(isCapability(action), action).toBe(false);
      for (const role of ROLES)
        expect(can(role, action, { priceBooks: true }), `${role} ${action}`).toBe(false);
    }
  });
});
