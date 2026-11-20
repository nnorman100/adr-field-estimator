import type { User } from 'firebase/auth';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readReadiness } from '@/lib/readiness/client';
import { readinessMarker, type MarkerRow, type ReadinessMarker } from '@/lib/readiness/marker';

const PARALLEL_CHECKS = 3;

type Run = {
  user: User;
  generation: number;
  controller: AbortController;
  markers: Map<string, ReadinessMarker>;
  asked: Map<string, number>;
  queue: MarkerRow[];
  active: number;
};

// One run per sign-in and list `generation` (bumped when the list starts to be read again from its
// first page); a run's answers are shown only while it is the live run. Rows added by
// "Show more jobs" join the run's queue; rows it already asked about keep their request and marker,
// unless their revision changed.
export function useReadinessMarkers(user: User, rows: readonly MarkerRow[] | null, capabilities: readonly string[], generation: number) {
  const live = rows !== null && capabilities.includes('scope');
  const editing = useMemo(() => (live ? rows.filter((row) => row.status === 'draft') : []), [live, rows]);
  const [result, setResult] = useState<{ user: User; generation: number; markers: ReadonlyMap<string, ReadinessMarker> } | null>(null);
  const run = useRef<Run | null>(null);

  useEffect(() => {
    if (!live) {
      run.current?.controller.abort();
      run.current = null;
      // The answers of the run that ended are not shown again when a new one starts.
      void Promise.resolve().then(() => setResult(null));
      return;
    }
    let batch = run.current;
    if (!batch || batch.user !== user || batch.generation !== generation || batch.controller.signal.aborted) {
      batch?.controller.abort();
      batch = run.current = { user, generation, controller: new AbortController(), markers: new Map(), asked: new Map(), queue: [], active: 0 };
      void Promise.resolve().then(() => setResult(null));
    }
    const current = batch;
    for (const row of editing) {
      if (current.asked.get(row.id) === row.revision) continue;
      current.asked.set(row.id, row.revision);
      current.markers.delete(row.id);
      current.queue.push(row);
    }
    async function checkRows() {
      current.active += 1;
      try {
        while (!current.controller.signal.aborted) {
          const row = current.queue.shift();
          if (!row) return;
          const answer = await readReadiness(current.user, row.id, current.controller.signal);
          if (current.controller.signal.aborted) return;
          const marker = readinessMarker(row, answer, capabilities);
          if (marker && current.asked.get(row.id) === row.revision) current.markers.set(row.id, marker);
          setResult({ user: current.user, generation: current.generation, markers: new Map(current.markers) });
        }
      } finally {
        current.active -= 1;
      }
    }
    while (current.active < PARALLEL_CHECKS && current.queue.length > 0) void checkRows();
  }, [live, user, generation, editing, capabilities]);

  useEffect(() => () => run.current?.controller.abort(), []);

  return live && result?.user === user && result.generation === generation ? result.markers : null;
}
