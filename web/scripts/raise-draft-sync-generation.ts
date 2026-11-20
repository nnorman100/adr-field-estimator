// Owner-run, after a Postgres restore that the app serves from (docs/runbook/backups.md, "Draft sync
// after a Postgres restore"): raises the draft sync's generation by one. The draft sync (src/lib/jobs/
// draft-sync.ts) reads the generation inside every sync transaction, so once it is raised, each job's
// next sync is the reset: it writes Postgres's restored state over whatever the field database holds
// for the job, however much higher the versions on the job's marker and drafts are.
//
//   npm run platform:raise-draft-sync-generation -- --project dryscope --database dryscope-field-test
//
// It runs with the person's own Google credentials (`gcloud auth application-default login`), changes
// only `draftSyncGeneration/current` (one server-only document, closed to every phone by
// web/firestore.rules), in one transaction, and prints the generation before and after. Running it
// twice raises it twice, which is harmless (each raise is one more reset). A document that is not
// `{ gen }` with a non-negative integer stops it, changing nothing.
import { pathToFileURL } from 'node:url';
import type { Firestore } from 'firebase-admin/firestore';
import { parseGeneration } from '../src/lib/jobs/draft-lifecycle';
import { GENERATION_PATH } from '../src/lib/jobs/draft-sync';
import { PROJECT_ID } from './create-tenant';

export type RaiseOptions = { project: string; database: string };

// A Firestore database id: lowercase letters, digits and hyphens, or "(default)".
const DATABASE_ID = /^(?:\(default\)|[a-z][a-z0-9-]{2,62})$/;

export function parseRaiseArgs(argv: string[]): RaiseOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--project' || arg === '--database') {
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
  return { project, database };
}

/** Raises the stored generation by one, in one transaction; the generation before and after. */
export async function raiseGeneration(db: Firestore): Promise<{ from: number; to: number }> {
  const ref = db.doc(GENERATION_PATH);
  return db.runTransaction(async (tx) => {
    const from = parseGeneration((await tx.get(ref)).data());
    tx.set(ref, { gen: from + 1 });
    return { from, to: from + 1 };
  });
}

async function main() {
  const options = parseRaiseArgs(process.argv.slice(2));
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const db = getFirestore(initializeApp({ projectId: options.project }, 'dryscope-raise-draft-sync-generation'), options.database);
  const { from, to } = await raiseGeneration(db);
  console.log(`draft sync generation raised from ${from} to ${to} in ${options.project}/${options.database}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Fixed text and our own messages only: the SDK's message may quote a path.
    console.error(error instanceof Error && !/firestore|grpc/i.test(error.message) ? error.message : 'raising the draft sync generation failed');
    process.exit(1);
  });
}
