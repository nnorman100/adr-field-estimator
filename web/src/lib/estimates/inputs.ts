import { z } from 'zod';
import type { EstimateJob, Json } from '@/engine/estimate';
import { draftFieldSchema, photoFieldSchema, roomFieldSchema, SHOT_NAMES, SHOT_TAGS, UNTAGGED_ALBUM } from '@/lib/field/schema';
import { toInspection } from '@/lib/field/inspection';
import type { CompanyDocuments } from '@/lib/profile/documents';
import { SNAPSHOT_FORMAT, type Snapshot } from '@/lib/submissions/snapshot';

// From a submitted record to the engine's input (docs/plans/S5.md, S5a-9): the estimate and the
// four documents are built from the record's snapshot only (section 4, step 4), never from the
// field draft or from the evidence registry by job, and from the company's own document inputs.
// Pure functions, so the mapping is unit-tested without a database.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const fieldDoc = z.strictObject({ id: z.string().min(1), field: z.unknown() });

// The stored snapshot, read back through one schema (S5a-8 wrote it as canonical JSON). Only what
// the estimate reads is checked in depth; the field maps are checked by the field map's own schemas.
const snapshotSchema = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  submissionId: z.string().regex(UUID),
  jobId: z.string().regex(UUID),
  draftId: z.string().regex(UUID),
  fieldSha256: z.string().regex(SHA256),
  field: z.strictObject({ draft: z.unknown(), rooms: z.array(fieldDoc), photos: z.array(fieldDoc) }),
  photos: z.array(z.strictObject({ id: z.string().regex(UUID), sha256: z.string().regex(SHA256), sizeBytes: z.number().int(), contentType: z.string() })),
  job: z.strictObject({ propertyAddress: z.string() }),
  customer: z.strictObject({ name: z.string(), phone: z.string(), email: z.string() }),
  claim: z.record(z.string(), z.string().nullable()),
});

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** A stored snapshot's bytes as the record they hold; throws SnapshotError on bytes that are not one. */
export function readSnapshot(bytes: Uint8Array): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new SnapshotError('the snapshot is not JSON');
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) throw new SnapshotError('the snapshot is not a submission snapshot');
  return parsed.data as Snapshot;
}

/** How the photo log names a photo whose reference names no room of the record. */
export const NO_ROOM = 'No room recorded';

// The claim as the documents print it: the engine's names, and empty text for a value not given.
const CLAIM_KEYS: Array<[string, string]> = [
  ['carrier', 'carrier'],
  ['claimNumber', 'claim_number'],
  ['policyNumber', 'policy_number'],
  ['dateOfLoss', 'date_of_loss'],
  ['lossCause', 'loss_cause'],
  ['adjusterName', 'adjuster_name'],
  ['adjusterEmail', 'adjuster_email'],
  ['adjusterPhone', 'adjuster_phone'],
  ['deductible', 'deductible'],
];

function claimOf(claim: Snapshot['claim']): Json {
  // No claim saved for the job: the letter falls back to the claims examiner.
  if (Object.keys(claim).length === 0) return null;
  const out: { [key: string]: Json } = {};
  for (const [from, to] of CLAIM_KEYS) out[to] = claim[from] ?? '';
  return out;
}

/**
 * The photo log in the company's grouping (S5a-9c). By room, the default: the photos of each room in
 * the record's room order, then the photos tied to no room, with the rows as S5a-9 made them. By shot
 * tag: albums in the field map's shot-tag order, photos with no tag last, each row naming its album.
 * Either way each photo is the record's own: its id, its room and the hash the evidence registry held
 * when it was submitted; only the order and the album headings differ. Within a room or an album the
 * photos keep the snapshot's order (sorted by photo id), which is not capture order: the snapshot
 * holds no capture time.
 */
function photoLog(snapshot: Snapshot, grouping: CompanyDocuments['settings']['photoLogGrouping']): Json[] {
  const draft = draftFieldSchema.parse(snapshot.field.draft ?? {});
  const names = new Map<string, string>();
  for (const room of snapshot.field.rooms) names.set(room.id, roomFieldSchema.parse(room.field ?? {}).name ?? '');
  const order = draft.roomOrder ?? [];
  const hashes = new Map(snapshot.photos.map((photo) => [photo.id, photo.sha256]));
  const rows = snapshot.field.photos.map((doc) => {
    const field = photoFieldSchema.parse(doc.field ?? {});
    const sha256 = hashes.get(doc.id);
    if (!sha256) throw new SnapshotError('a photo reference has no stored photo in the record');
    const roomId = field.roomId !== undefined && names.has(field.roomId) ? field.roomId : null;
    const row: { [key: string]: Json } = { id: doc.id, room: roomId === null ? NO_ROOM : names.get(roomId)!, sha256 };
    if (field.shotTag !== undefined) row.shot_tag = field.shotTag;
    if (grouping === 'shot_tag') row.album = field.shotTag === undefined ? UNTAGGED_ALBUM : SHOT_NAMES[field.shotTag];
    const rank = grouping === 'shot_tag' ? (field.shotTag === undefined ? SHOT_TAGS.length : SHOT_TAGS.indexOf(field.shotTag)) : roomId === null ? order.length : order.indexOf(roomId);
    return { row, rank };
  });
  // A stable sort: within a room or an album the photos keep the snapshot's order.
  return rows.sort((a, b) => a.rank - b.rank).map((photo) => photo.row);
}

export type EstimateInput = {
  job: EstimateJob;
  // The written summary of findings (owner decision J1), as submitted; empty when none was written.
  summary: string;
  scopeConfirmed: boolean;
};

/** The engine's input for one submitted record and the company's document inputs. */
export function estimateInput(snapshot: Snapshot, company: CompanyDocuments): EstimateInput {
  const draft = draftFieldSchema.parse(snapshot.field.draft ?? {});
  const inspection = toInspection(snapshot.field.draft, snapshot.field.rooms);
  inspection.address = snapshot.job.propertyAddress;
  const summary = draft.summary ?? '';
  const identity = company.identity;
  return {
    summary,
    scopeConfirmed: draft.scopeConfirmed === true,
    job: {
      inspection,
      documents: {
        company: {
          company_id: identity.companyId,
          version: 1,
          name: identity.name,
          address: identity.address,
          phone: identity.phone,
          email: identity.email,
          license: identity.license,
          signoff: identity.signoff,
        },
        claim: claimOf(snapshot.claim),
        photos: photoLog(snapshot, company.settings.photoLogGrouping),
        // The documents' summary is the technician's own (J1). AI suggestions arrive with S7.
        ai: { summary, suggestions: [], unpriced_work: [] },
        customer_name: snapshot.customer.name,
      },
    },
  };
}
