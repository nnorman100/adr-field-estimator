import { describe, expect, it } from 'vitest';
import { parseTargetArgs, ScriptError, stopMessage } from '../../scripts/target-args';

// The owner-run Firestore commands' shared arguments and what they print when they stop
// (scripts/target-args.ts): only their own messages, never a path or an SDK's text.

describe('parseTargetArgs', () => {
  it('takes the target only, or the target, --apply and each named export', () => {
    expect(parseTargetArgs(['--project', 'dryscope', '--database', 'dryscope-field-test'])).toEqual({ project: 'dryscope', database: 'dryscope-field-test' });
    expect(() => parseTargetArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '--apply'])).toThrow('unknown option --apply');
    expect(parseTargetArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '--a', 'a.csv'], { files: ['a'] })).toEqual({
      project: 'dryscope',
      database: 'dryscope-field-test',
      apply: false,
      files: { a: 'a.csv' },
    });
    expect(() => parseTargetArgs(['--project', 'dryscope', '--database', 'dryscope-field-test'], { files: ['a'] })).toThrow('--a is required');
  });

  it('never echoes a value it does not take', () => {
    let thrown: unknown;
    try {
      parseTargetArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '/home/someone/jobs.csv']);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScriptError);
    expect((thrown as Error).message).toBe('unexpected argument');
  });
});

describe('stopMessage', () => {
  it('prints a command’s own message, a fixed category for the file system, and the fallback for anything else', () => {
    expect(stopMessage(new ScriptError('--jobs is required'), 'failed')).toBe('--jobs is required');
    const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/home/someone/jobs.csv'"), { code: 'ENOENT' });
    expect(stopMessage(missing, 'failed')).toBe('reading an export failed');
    expect(stopMessage(new Error('7 PERMISSION_DENIED: projects/dryscope/databases/x'), 'failed')).toBe('failed');
    expect(stopMessage(new Error('a plain message that may quote a path /tmp/x'), 'failed')).toBe('failed');
  });
});
