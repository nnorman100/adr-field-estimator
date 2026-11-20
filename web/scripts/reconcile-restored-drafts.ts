// Owner-run, after a Postgres restore that the app serves from (docs/runbook/backups.md, "Draft sync
// after a Postgres restore"), once the draft sync's generation is raised: closes every field draft the
// restored Postgres does not give to the job the draft names. Drafts made after the restore point (a
// Back to editing, a New job, a copy), and drafts of jobs the restored Postgres does not have, are not
// in its job_drafts. No sync ever reaches the ones no marker lists, so they would stay open to whoever
// they name. Each is closed as the sync closes a draft Postgres no longer gives the job: archived and
// naming nobody, its field work kept (what becomes of it is the owner's decision).
//
//   npm run platform:reconcile-restored-drafts -- --project dryscope --database dryscope-field-test < job-drafts.csv
//   npm run platform:reconcile-restored-drafts -- --project dryscope --database dryscope-field-test --apply < job-drafts.csv
//
// The input is the CSV the runbook's query writes from the restored Postgres: company id, draft id, job
// id, one job_drafts row per line. Without --apply it only reads, and lists each draft it would close by
// company and draft id with the reason, then the counts; the owner checks the list before adding
// --apply. With --apply each one is changed only if it has not changed since it was read (an update
// precondition), so a draft a phone or the sync wrote meanwhile is read again on the next run. It runs
// with the person's own Google credentials and prints ids and counts, never field data.
import { pathToFileURL } from 'node:url';
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { PROJECT_ID } from './create-tenant';

export type ReconcileOptions = { project: string; database: string; apply: boolean };

// A Firestore database id: lowercase letters, digits and hyphens, or "(default)".
const DATABASE_ID = /^(?:\(default\)|[a-z][a-z0-9-]{2,62})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseReconcileArgs(argv: string[]): ReconcileOptions {
  const values: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply') apply = true;
    else if (arg === '--project' || arg === '--database') {
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
  return { project, database, apply };
}

/** The restored job_drafts: the job each draft is given to, by "company/draft". */
export type Claims = Map<string, string>;

// The runbook query's CSV: three uuids per line. Blank lines are skipped; anything else stops the run,
// so a truncated or wrong export is never read as "no draft is claimed" (which would close them all).
export function parseClaims(text: string): Claims {
  const claims: Claims = new Map();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const fields = line.split(',');
    if (fields.length !== 3 || !fields.every((field) => UUID.test(field))) {
      throw new Error(`line ${index + 1} is not "company id,draft id,job id"`);
    }
    const [companyId, draftId, jobId] = fields as [string, string, string];
    claims.set(`${companyId}/${draftId}`, jobId);
  }
  if (claims.size === 0) throw new Error('the job_drafts export is empty: nothing would be kept');
  return claims;
}

/** A field draft as the run reads it. */
export type FoundDraft = { companyId: string; draftId: string; jobId: unknown; state: unknown; fieldOwnerUid: unknown };

export type Closing = { companyId: string; draftId: string; reason: 'unclaimed' | 'another_job' };

/** The drafts to close: every one the restored Postgres does not give to the job it names, unless it is
 * already archived naming nobody. A draft with no job id is kept when Postgres claims it (the sync stamps it). */
export function draftsToClose(drafts: FoundDraft[], claims: Claims): Closing[] {
  const closing: Closing[] = [];
  for (const draft of drafts) {
    const claimed = claims.get(`${draft.companyId}/${draft.draftId}`);
    let reason: Closing['reason'] | null = null;
    if (claimed === undefined) reason = 'unclaimed';
    else if (draft.jobId !== undefined && draft.jobId !== claimed) reason = 'another_job';
    if (reason === null) continue;
    if (draft.state === 'archived' && draft.fieldOwnerUid === undefined) continue;
    closing.push({ companyId: draft.companyId, draftId: draft.draftId, reason });
  }
  return closing;
}

/** Every company's field drafts, with the update time each was read at. */
export async function readDrafts(db: Firestore): Promise<(FoundDraft & { readAt: Timestamp })[]> {
  const found: (FoundDraft & { readAt: Timestamp })[] = [];
  const snapshot = await db.collectionGroup('drafts').select('jobId', 'state', 'fieldOwnerUid').get();
  for (const doc of snapshot.docs) {
    const company = doc.ref.parent.parent;
    // Only companies/{company}/drafts/{draft}: no other collection is named drafts.
    if (!company || company.parent.id !== 'companies') continue;
    found.push({ companyId: company.id, draftId: doc.id, jobId: doc.get('jobId'), state: doc.get('state'), fieldOwnerUid: doc.get('fieldOwnerUid'), readAt: doc.updateTime });
  }
  return found;
}

/** Closes each draft (archived, naming nobody) if it has not changed since it was read; how many were. */
export async function closeDrafts(db: Firestore, closing: (Closing & { readAt: Timestamp })[]): Promise<{ closed: number; changed: number }> {
  const { FieldValue } = await import('firebase-admin/firestore');
  let closed = 0;
  let changed = 0;
  for (const draft of closing) {
    const ref = db.collection('companies').doc(draft.companyId).collection('drafts').doc(draft.draftId);
    try {
      await ref.update({ state: 'archived', fieldOwnerUid: FieldValue.delete() }, { lastUpdateTime: draft.readAt });
      closed++;
    } catch (error) {
      // FAILED_PRECONDITION: written since it was read. Left for the next run, which reads it again.
      if ((error as { code?: unknown }).code !== 9) throw error;
      changed++;
    }
  }
  return { closed, changed };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const options = parseReconcileArgs(process.argv.slice(2));
  const claims = parseClaims(await readStdin());
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const db = getFirestore(initializeApp({ projectId: options.project }, 'dryscope-reconcile-restored-drafts'), options.database);
  const drafts = await readDrafts(db);
  const byKey = new Map(drafts.map((draft) => [`${draft.companyId}/${draft.draftId}`, draft]));
  const closing = draftsToClose(drafts, claims);
  for (const draft of closing) console.log(`${options.apply ? 'closing' : 'would close'}: ${draft.companyId}/${draft.draftId} (${draft.reason})`);
  console.log(`read ${drafts.length} drafts against ${claims.size} job_drafts rows: ${closing.length} to close.`);
  if (!options.apply) {
    console.log(closing.length === 0 ? 'nothing to close.' : 'check the list, then run again with --apply.');
    return;
  }
  const { closed, changed } = await closeDrafts(db, closing.map((draft) => ({ ...draft, readAt: byKey.get(`${draft.companyId}/${draft.draftId}`)!.readAt })));
  console.log(`closed ${closed}; ${changed} changed since they were read: run it again.`);
  if (changed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Fixed text and our own messages only: the SDK's message may quote a path.
    console.error(error instanceof Error && !/firestore|grpc/i.test(error.message) ? error.message : 'reconciling the drafts failed');
    process.exit(1);
  });
}
