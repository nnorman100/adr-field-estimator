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
// company and draft id with the reason, each one not given to its job that is closed already (listed,
// never written), then the counts; the owner checks the list before adding --apply. With --apply each one is changed only if it has not changed since it was read (an update
// precondition), so a draft a phone or the sync wrote meanwhile is read again on the next run. It runs
// with the person's own Google credentials and prints ids and counts, never field data.
import { pathToFileURL } from 'node:url';
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { parseTargetArgs } from './target-args';

export type ReconcileOptions = { project: string; database: string; apply: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseReconcileArgs(argv: string[]): ReconcileOptions {
  return parseTargetArgs(argv, { apply: true });
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

/** Why the restored Postgres does not give this draft to the job it names, or null when it does. A draft
 * with no job id is given when Postgres claims it (the sync stamps it). */
function reasonOf(draft: FoundDraft, claims: Claims): Closing['reason'] | null {
  const claimed = claims.get(`${draft.companyId}/${draft.draftId}`);
  if (claimed === undefined) return 'unclaimed';
  if (draft.jobId !== undefined && draft.jobId !== claimed) return 'another_job';
  return null;
}

const closedAlready = (draft: FoundDraft) => draft.state === 'archived' && draft.fieldOwnerUid === undefined;

/** The drafts to close: every one the restored Postgres does not give to the job it names, unless it is
 * already archived naming nobody. */
export function draftsToClose(drafts: FoundDraft[], claims: Claims): Closing[] {
  return drafts.flatMap((draft) => {
    const reason = reasonOf(draft, claims);
    return reason === null || closedAlready(draft) ? [] : [{ companyId: draft.companyId, draftId: draft.draftId, reason }];
  });
}

/** The drafts the restored Postgres does not give to the job they name that are closed already (the
 * sync's reset or an earlier run closed them): listed, never written, so the owner's list of field work to
 * decide on is whole. */
export function draftsAlreadyClosed(drafts: FoundDraft[], claims: Claims): Closing[] {
  return drafts.flatMap((draft) => {
    const reason = reasonOf(draft, claims);
    return reason !== null && closedAlready(draft) ? [{ companyId: draft.companyId, draftId: draft.draftId, reason }] : [];
  });
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
  const closed = draftsAlreadyClosed(drafts, claims);
  for (const draft of closed) console.log(`already closed: ${draft.companyId}/${draft.draftId} (${draft.reason})`);
  for (const draft of closing) console.log(`${options.apply ? 'closing' : 'would close'}: ${draft.companyId}/${draft.draftId} (${draft.reason})`);
  console.log(`read ${drafts.length} drafts against ${claims.size} job_drafts rows: ${closing.length} to close, ${closed.length} closed already.`);
  if (!options.apply) {
    console.log(closing.length === 0 ? 'nothing to close.' : 'check the list, then run again with --apply.');
    return;
  }
  const written = await closeDrafts(db, closing.map((draft) => ({ ...draft, readAt: byKey.get(`${draft.companyId}/${draft.draftId}`)!.readAt })));
  const changed = written.changed;
  console.log(`closed ${written.closed}; ${changed} changed since they were read: run it again.`);
  if (changed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Fixed text and our own messages only: the SDK's message may quote a path.
    console.error(error instanceof Error && !/firestore|grpc/i.test(error.message) ? error.message : 'reconciling the drafts failed');
    process.exit(1);
  });
}
