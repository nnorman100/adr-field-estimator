import type { FieldDoc, FieldManifest } from '@/lib/field/canonical';

// The keys of a signed draft's field map a copy leaves out: what the technician approved on the
// signed visit, which they confirm again on the new draft (the old app's copy cleared the same).
// The field map holds no transcript (a Live walkthrough's transcript is never kept in a draft), and
// photos are not copied: they are the signed job's evidence and stay with it.
export const COPY_CLEARED_KEYS = ['scopeConfirmed'] as const;

// The field map and rooms a copy starts from: its source's, in a fresh map less COPY_CLEARED_KEYS
// (the photos stay the signed job's evidence). Used by Copy (archive.ts) and the draft sync
// (draft-lifecycle.ts).
export function copiedManifest(manifest: Pick<FieldManifest, 'draft' | 'rooms'>): { draft: Record<string, unknown>; rooms: FieldDoc[] } {
  const draft = { ...((manifest.draft ?? {}) as Record<string, unknown>) };
  for (const key of COPY_CLEARED_KEYS) delete draft[key];
  return { draft, rooms: manifest.rooms };
}
