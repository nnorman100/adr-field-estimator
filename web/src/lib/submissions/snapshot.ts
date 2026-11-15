import { createHash } from 'node:crypto';
import { canonicalJson, canonicalManifest, type FieldDoc, type FieldManifest } from '@/lib/field/canonical';
import { FieldMapError, toInspection } from '@/lib/field/inspection';
import { fieldId, photoFieldSchema } from '@/lib/field/schema';

// The submitted record's snapshot (docs/plans/S5.md, section 4, step 4): the fenced draft in its
// canonical form, the photo ids and hashes the evidence registry holds for its references, and the
// job header, customer and claim as they stood when the record was made. Estimates, documents,
// review and signing read only this (S5a-9 onward); documents list photos from here, never from
// the registry by job, so bytes uploaded later change nothing. Stored as canonical JSON bytes with
// their SHA-256 (the database checks the hash against the bytes).

export const SNAPSHOT_FORMAT = 'dryscope-submission-v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SnapshotPhoto = { id: string; sha256: string; sizeBytes: number; contentType: string; receivedAt?: string };

export type Snapshot = {
  format: typeof SNAPSHOT_FORMAT;
  submissionId: string;
  jobId: string;
  draftId: string;
  // The phone's digest of `field`, which the server recomputed and found equal.
  fieldSha256: string;
  field: FieldManifest;
  photos: SnapshotPhoto[];
  job: { propertyAddress: string };
  customer: { name: string; phone: string; email: string };
  claim: Record<string, string | null>;
};

// Why a fenced draft cannot be recorded as it is, or null when it can: every map matches field map
// v1 and the draft maps to the engine's inspection (each room listed in the room order and named),
// and each photo reference names a photo by the uuid the photo route stored it under.
export function manifestProblem(manifest: FieldManifest): 'draft_invalid' | 'photo_missing' | null {
  try {
    toInspection(
      manifest.draft,
      manifest.rooms.map((room) => {
        if (!fieldId.safeParse(room.id).success) throw new FieldMapError('a room id is not a field id');
        return room;
      }),
    );
  } catch (error) {
    if (error instanceof FieldMapError) return 'draft_invalid';
    throw error;
  }
  for (const photo of manifest.photos) {
    if (!photoFieldSchema.safeParse(photo.field ?? {}).success) return 'draft_invalid';
    if (!UUID.test(photo.id)) return 'photo_missing';
  }
  return null;
}

/** The manifest exactly as it will be stored: canonical order, a missing map as an empty one. */
export function storedManifest(manifest: FieldManifest): FieldManifest {
  return JSON.parse(canonicalManifest(manifest)) as FieldManifest;
}

export function snapshotBytes(snapshot: Snapshot): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(canonicalJson(snapshot), 'utf8');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The field data of a stored snapshot, for Back to editing. */
export function snapshotManifest(bytes: Buffer | Uint8Array): FieldManifest {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<Snapshot>;
  if (parsed.format !== SNAPSHOT_FORMAT || !parsed.field) throw new Error('not a submission snapshot');
  const docs = (list: unknown): FieldDoc[] => (Array.isArray(list) ? (list as FieldDoc[]) : []);
  return { draft: parsed.field.draft ?? {}, rooms: docs(parsed.field.rooms), photos: docs(parsed.field.photos) };
}
