// The owner-run Firestore commands' arguments (check-draft-states, raise-draft-sync-generation,
// reconcile-restored-drafts): the project and the field database they work on, both required; for a
// command that lists before it writes, `--apply`; and for one that reads named exports, each export's
// file, required. Anything else is refused.
import { PROJECT_ID } from './create-tenant';

// A Firestore database id: lowercase letters, digits and hyphens, or "(default)".
const DATABASE_ID = /^(?:\(default\)|[a-z][a-z0-9-]{2,62})$/;

export type Target = { project: string; database: string };

export function parseTargetArgs(argv: string[]): Target;
export function parseTargetArgs<F extends string>(argv: string[], options: { apply: true; files?: readonly F[] }): Target & { apply: boolean; files: Record<F, string> };
export function parseTargetArgs(argv: string[], options: { apply?: boolean; files?: readonly string[] } = {}): Target & { apply?: boolean; files?: Record<string, string> } {
  const values: Record<string, string> = {};
  const files: Record<string, string> = {};
  const named = new Set((options.files ?? []).map((name) => `--${name}`));
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply' && options.apply) apply = true;
    else if (named.has(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i++;
      files[arg.slice(2)] = value;
    } else if (arg === '--project' || arg === '--database') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i++;
      values[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else throw new Error(`unexpected argument ${arg}`);
  }
  const { project, database } = values;
  if (!project) throw new Error('--project is required');
  if (!PROJECT_ID.test(project)) throw new Error('--project must be a Google Cloud project id');
  if (!database) throw new Error('--database is required');
  if (!DATABASE_ID.test(database)) throw new Error('--database must be a Firestore database id');
  for (const name of options.files ?? []) if (!files[name]) throw new Error(`--${name} is required`);
  if (!options.apply) return { project, database };
  return options.files ? { project, database, apply, files } : { project, database, apply };
}
