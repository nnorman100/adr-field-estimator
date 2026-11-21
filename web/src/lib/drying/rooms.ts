import { and, eq } from 'drizzle-orm';
import { jobSubmissions } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import type { FieldManifest } from '@/lib/field/canonical';
import type { JobRow } from '@/lib/jobs/access';
import { snapshotManifest } from '@/lib/submissions/snapshot';
import { roomLabelOk } from './schema';

// Where a reading's room comes from (S5b-10/11 plan, 10B "Reading calculation and room source"): the
// room of the requested job only, chosen by its stable field id, with its name as it reads now kept as
// the reading's label, so a later rename or removal leaves the reading's history as it was.
//
// - A job being edited (`draft`): the rooms of its current field draft, from the bounded read of the
//   draft (src/lib/readiness/reader.ts) the service makes before its write.
// - A submitted or signed job: the rooms of the immutable snapshot its current draft was committed
//   with (job_submissions, one committed row per draft).

export type ReadingRoom = { id: string; label: string };

type RoomDoc = { id: string; field: unknown };

// The room under `roomId` among a manifest's rooms, listed in the draft's room order (a room document
// the order does not list is not one of the job's rooms), with a name the database keeps as a label.
function roomIn(manifest: FieldManifest, roomId: string): ReadingRoom | null {
  const order = (manifest.draft as { roomOrder?: unknown } | null | undefined)?.roomOrder;
  if (!Array.isArray(order) || !order.includes(roomId)) return null;
  const found = manifest.rooms.find((room: RoomDoc) => room.id === roomId);
  const name = (found?.field as { name?: unknown } | null | undefined)?.name;
  return found && roomLabelOk(name) ? { id: roomId, label: name } : null;
}

/** The room of a draft's manifest read from the field database, or null when it has none by that id. */
export function draftRoom(manifest: FieldManifest, roomId: string): ReadingRoom | null {
  return roomIn(manifest, roomId);
}

/** The room of the snapshot the job's current draft was committed with, or null. */
export async function submittedRoom(tx: CompanyTransaction, job: JobRow, roomId: string): Promise<ReadingRoom | null> {
  const [committed] = await tx
    .select({ bytes: jobSubmissions.snapshotBytes })
    .from(jobSubmissions)
    .where(
      and(
        eq(jobSubmissions.companyId, job.companyId),
        eq(jobSubmissions.jobId, job.id),
        eq(jobSubmissions.draftId, job.currentDraftId),
        eq(jobSubmissions.status, 'committed'),
      ),
    )
    .limit(1);
  if (!committed?.bytes) return null;
  let manifest: FieldManifest;
  try {
    manifest = snapshotManifest(committed.bytes);
  } catch {
    return null;
  }
  return roomIn(manifest, roomId);
}
