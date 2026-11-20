import { readinessAnswerSchema } from './schema';

// The jobs list's readiness marker (S5b-11; docs/spec/screens/jobs-list.md): a gap count, or "Ready
// to review", on a visible editing row for the owner or the estimator. The list itself is unchanged
// (GET /api/jobs keeps its paging and filters, and stores no readiness): the screen asks the readiness
// route for each visible editing row and shows a marker only for a current answer about that row.
// No marker (null) is the answer whenever that cannot be shown: another role, a row that is not an
// editing draft, an answer that is missing, of another shape, about another job or another revision
// of it, one that says the check was unavailable, or one with no gap that is not `ready` (a check it
// could not run is not a pass). Shared with the screens, so it holds no server code.

export type ReadinessMarker = { kind: 'ready' } | { kind: 'gaps'; count: number };

export type MarkerRow = { id: string; status: string; revision: number };

export function readinessMarker(row: MarkerRow, answer: unknown, capabilities: readonly string[]): ReadinessMarker | null {
  if (!capabilities.includes('scope') || row.status !== 'draft') return null;
  const parsed = readinessAnswerSchema.safeParse(answer);
  if (!parsed.success || parsed.data.status !== 'checked') return null;
  const checked = parsed.data;
  if (checked.jobId !== row.id || checked.jobRevision !== row.revision) return null;
  if (checked.gaps.length > 0) return { kind: 'gaps', count: checked.gaps.length };
  return checked.ready ? { kind: 'ready' } : null;
}
