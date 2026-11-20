// The owner-run Firestore commands' arguments (check-draft-states, raise-draft-sync-generation,
// reconcile-restored-drafts): the project and the field database they work on, both required; and for a
// command that reads named exports and lists before it writes, each export's file (required) and
// `--apply`. Anything else is refused.
import { PROJECT_ID } from './create-tenant';

// A Firestore database id: lowercase letters, digits and hyphens, or "(default)".
const DATABASE_ID = /^(?:\(default\)|[a-z][a-z0-9-]{2,62})$/;

/** A command's own message: the only kind the owner-run commands print as it is. */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

export type Target = { project: string; database: string };

export function parseTargetArgs(argv: string[]): Target;
export function parseTargetArgs<F extends string>(argv: string[], options: { files: readonly F[] }): Target & { apply: boolean; files: Record<F, string> };
export function parseTargetArgs(argv: string[], options?: { files: readonly string[] }): Target | (Target & { apply: boolean; files: Record<string, string> }) {
  const values: Record<string, string> = {};
  const files: Record<string, string> = {};
  const named = new Set((options?.files ?? []).map((name) => `--${name}`));
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply' && options) apply = true;
    else if (arg === '--project' || arg === '--database' || named.has(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new ScriptError(`${arg} needs a value`);
      i++;
      if (named.has(arg)) files[arg.slice(2)] = value;
      else values[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) throw new ScriptError(`unknown option ${arg}`);
    // A value the command does not take is never echoed: it may be a path or anything else the person typed.
    else throw new ScriptError('unexpected argument');
  }
  const { project, database } = values;
  if (!project) throw new ScriptError('--project is required');
  if (!PROJECT_ID.test(project)) throw new ScriptError('--project must be a Google Cloud project id');
  if (!database) throw new ScriptError('--database is required');
  if (!DATABASE_ID.test(database)) throw new ScriptError('--database must be a Firestore database id');
  if (!options) return { project, database };
  for (const name of options.files) if (!files[name]) throw new ScriptError(`--${name} is required`);
  return { project, database, apply, files };
}

/** What an owner-run command prints when it stops: its own message, or a fixed category. */
export function stopMessage(error: unknown, fallback: string): string {
  if (error instanceof ScriptError) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return 'reading an export failed';
  return fallback;
}
