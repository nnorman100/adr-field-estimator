'use client';

import type { User } from 'firebase/auth';
import { useEffect, useMemo, useRef, useState } from 'react';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { callApi } from '@/lib/firebase-client';
import type { MarkerRow, ReadinessMarker } from './marker';
import { readinessAnswerSchema, type ReadinessAnswer } from './schema';

const CHECK_WITHIN_MS = 4_000;

const ARCHIVED = 'archived' as const;

export function readReadiness(user: User, jobId: string, signal: AbortSignal): Promise<ReadinessAnswer | typeof ARCHIVED | null> {
  // The timeout also bounds waiting for the client's Auth or App Check token.
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    const check = new AbortController();
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      check.abort();
      resolve(null);
    };
    const timer = setTimeout(stop, CHECK_WITHIN_MS);
    signal.addEventListener('abort', stop, { once: true });
    void callApi(user, `/api/jobs/${encodeURIComponent(jobId)}/readiness`, { signal: check.signal }).then(({ status, body }) => {
      if (check.signal.aborted) return;
      if (status === 410) return resolve(ARCHIVED);
      if (status === 200) {
        const answer = readinessAnswerSchema.safeParse(body);
        if (answer.success) resolve(answer.data);
      }
    }).finally(stop);
  });
}

type DraftBasis = MarkerRow & { currentDraftId: string };
type Checked = Extract<ReadinessAnswer, { status: 'checked' }>;

export function useDraftReadiness(user: User, job: DraftBasis | null, manifest: FieldManifest | null, recheck: number, onArchived: () => void) {
  const basis = useMemo(() => (job && manifest ? { user, job, manifest, recheck } : null), [user, job, manifest, recheck]);
  const archived = useRef(onArchived);
  useEffect(() => {
    archived.current = onArchived;
  }, [onArchived]);
  const [result, setResult] = useState<{ basis: NonNullable<typeof basis>; answer: Checked | null } | null>(null);
  useEffect(() => {
    if (!basis) return;
    const controller = new AbortController();
    const { user, job, manifest } = basis;
    void Promise.all([readReadiness(user, job.id, controller.signal), manifestDigest(manifest).catch(() => null)]).then(([answer, digest]) => {
      if (controller.signal.aborted) return;
      if (answer === ARCHIVED) archived.current();
      const current =
        typeof answer === 'object' && answer?.status === 'checked' && answer.jobId === job.id && answer.jobRevision === job.revision &&
        answer.draftId === job.currentDraftId && answer.fieldSha256 === digest;
      setResult({ basis, answer: current ? answer : null });
    });
    return () => controller.abort();
  }, [basis]);

  // A render with a new draft, revision or sign-in never uses the previous result, even before
  // the previous request's effect is cleaned up.
  return result?.basis === basis ? result.answer : undefined;
}

export const markerText = (marker: ReadinessMarker): string =>
  marker.kind === 'ready' ? 'Ready to review' : marker.count === 1 ? '1 item to check' : `${marker.count} items to check`;
