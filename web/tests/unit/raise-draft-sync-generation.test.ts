import { describe, expect, it } from 'vitest';
import { parseRaiseArgs } from '../../scripts/raise-draft-sync-generation';

// The owner-run raise of the draft sync generation after a Postgres restore (docs/runbook/backups.md).
// Its write, against the emulator, is in tests/emu/draft-sync.test.ts.

describe('parseRaiseArgs', () => {
  it('needs a project and a Firestore database id, and nothing else', () => {
    expect(parseRaiseArgs(['--project', 'dryscope', '--database', 'dryscope-field-test'])).toEqual({ project: 'dryscope', database: 'dryscope-field-test' });
    expect(parseRaiseArgs(['--database', '(default)', '--project', 'dryscope-live'])).toEqual({ project: 'dryscope-live', database: '(default)' });
    expect(() => parseRaiseArgs(['--database', 'dryscope-field-test'])).toThrow('--project is required');
    expect(() => parseRaiseArgs(['--project', 'dryscope'])).toThrow('--database is required');
    expect(() => parseRaiseArgs(['--project', 'Not A Project', '--database', 'x-db'])).toThrow('--project must be');
    expect(() => parseRaiseArgs(['--project', 'dryscope', '--database', 'Bad/Db'])).toThrow('--database must be');
    expect(() => parseRaiseArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '--to', '5'])).toThrow('unknown option --to');
    // A value it does not take is refused without being echoed (it may be a path).
    expect(() => parseRaiseArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', 'extra'])).toThrow(/^unexpected argument$/);
    expect(() => parseRaiseArgs(['--project'])).toThrow('--project needs a value');
  });
});
