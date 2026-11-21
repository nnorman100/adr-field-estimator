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
import { MalformedGenerationError, parseGeneration } from '../src/lib/jobs/draft-lifecycle';
import { GENERATION_PATH } from '../src/lib/jobs/draft-sync';
import { parseTargetArgs, ScriptError, stopMessage } from './target-args';

export type RaiseOptions = { project: string; database: string };

export function parseRaiseArgs(argv: string[]): RaiseOptions {
  return parseTargetArgs(argv);
}

/** Raises the stored generation by one, in one transaction; the generation before and after. */
export async function raiseGeneration(db: Firestore): Promise<{ from: number; to: number }> {
  const ref = db.doc(GENERATION_PATH);
  return db.runTransaction(async (tx) => {
    let from: number;
    try {
      from = parseGeneration((await tx.get(ref)).data());
    } catch (error) {
      if (error instanceof MalformedGenerationError) throw new ScriptError('the draft sync generation document is not { gen } with a non-negative integer: nothing changed');
      throw error;
    }
    // A generation the sync could not read back (past the largest safe integer) is never written.
    if (!Number.isSafeInteger(from + 1)) throw new ScriptError('the draft sync generation cannot be raised further');
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
    // Its own messages and fixed categories only: an SDK's or the file system's message may quote a path.
    console.error(stopMessage(error, 'raising the draft sync generation failed'));
    process.exit(1);
  });
}
