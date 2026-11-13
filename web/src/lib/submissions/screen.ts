import type { FieldManifest } from '@/lib/field/canonical';

// What the Finish and review screen decides in the browser, as pure functions so they are
// unit-tested. Everything here is convenience: the server checks the sign-in, the job, the role and
// the draft again on every call (src/lib/submissions/http.ts), so a wrong answer here shows the
// wrong screen but never grants anything. Words come from fixed codes only; nothing the person typed
// goes into a message.

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// GET /api/me's answer: the company id the field draft lives under, and whether the role may
// finish a job (`scope`: the owner and the estimator). null for an answer of an unexpected shape.
export type Finisher = { companyId: string; canFinish: boolean };

export function finisherOf(body: unknown): Finisher | null {
  const companyId = field(field(body, 'company'), 'id');
  const capabilities = field(body, 'capabilities');
  if (typeof companyId !== 'string' || !Array.isArray(capabilities)) return null;
  return { companyId, canFinish: capabilities.includes('scope') };
}

// GET /api/jobs/{id}'s job, or the job state Submit and Back to editing answer with.
export type JobOnScreen = { id: string; status: string; currentDraftId: string };

export function jobOf(body: unknown): JobOnScreen | null {
  const job = field(body, 'job');
  const id = field(job, 'id');
  const status = field(job, 'status');
  const currentDraftId = field(job, 'currentDraftId');
  if (typeof id !== 'string' || typeof status !== 'string' || typeof currentDraftId !== 'string') return null;
  return { id, status, currentDraftId };
}

// What the screen lists before Finish: the rooms in the technician's order, the photo count and
// whether the summary of findings is written.
export type DraftSummary = { rooms: string[]; photos: number; summaryWritten: boolean; unnamedRooms: number };

export function draftSummary(manifest: FieldManifest): DraftSummary {
  const draft = (manifest.draft ?? {}) as Record<string, unknown>;
  const order = Array.isArray(draft.roomOrder) ? (draft.roomOrder as unknown[]).filter((id): id is string => typeof id === 'string') : [];
  const byId = new Map(manifest.rooms.map((room) => [room.id, field(room.field, 'name')]));
  const ids = [...order.filter((id) => byId.has(id)), ...manifest.rooms.map((room) => room.id).filter((id) => !order.includes(id))];
  const names = ids.map((id) => byId.get(id));
  return {
    rooms: names.filter((name): name is string => typeof name === 'string' && name.trim() !== ''),
    photos: manifest.photos.length,
    summaryWritten: typeof draft.summary === 'string' && draft.summary.trim() !== '',
    unnamedRooms: names.filter((name) => typeof name !== 'string' || name.trim() === '').length,
  };
}

// What to do after a refused or failed call: `retry` sends the same request again (its id makes it
// safe), `reload` reads the draft again and starts over with a new id, `done` shows the job as it is.
export type Next = 'retry' | 'reload' | 'done';

const OUTCOMES: Record<string, { message: string; next: Next }> = {
  submissions_unavailable: { message: 'We could not reach DryScope. Check your connection, then try again.', next: 'retry' },
  digest_mismatch: {
    message: 'The draft changed while you were finishing: a change from another phone, or one that had not saved yet. Check it below, then finish again.',
    next: 'reload',
  },
  submission_in_progress: { message: 'Someone is finishing this job right now. Wait a minute, then reload.', next: 'reload' },
  submission_aborted: { message: 'That attempt was stopped before it was saved. Check the draft, then finish again.', next: 'reload' },
  photo_missing: { message: 'A photo has not finished uploading. Send it again from the Photos screen, then finish again.', next: 'reload' },
  draft_invalid: { message: 'Every room needs a name, and each room must be in the room list. Fix the draft, then finish again.', next: 'reload' },
  draft_missing: { message: 'This job has no draft to finish. Reload the job.', next: 'reload' },
  not_current_draft: { message: 'This job has a newer draft. Reload the job.', next: 'reload' },
  already_submitted: { message: 'This draft is already finished.', next: 'done' },
  not_submitted: { message: 'This job is still being edited.', next: 'done' },
  job_signed: { message: 'This job is signed. A signed job changes only through a change order.', next: 'done' },
  conflict: { message: 'This job was already changed on another phone. Reload the job.', next: 'reload' },
  not_allowed: { message: 'Only the owner or the estimator on this job can do this.', next: 'done' },
  not_found: { message: 'This job could not be found.', next: 'done' },
  archived: { message: 'This job is archived.', next: 'done' },
};

export function outcomeOf(status: number, body: unknown): { message: string; next: Next } {
  const code = field(body, 'error');
  const known = typeof code === 'string' ? OUTCOMES[code] : undefined;
  if (known) return known;
  // No answer, or one of an unknown shape: the same request again is safe.
  return status === 0 || status >= 500 ? OUTCOMES.submissions_unavailable! : { message: 'Something went wrong. Reload the job.', next: 'reload' };
}
