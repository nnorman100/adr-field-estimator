import type { User } from 'firebase/auth';
import { useEffect, useMemo, useState } from 'react';
import { readReadiness } from '@/lib/readiness/client';
import { readinessMarker, type MarkerRow, type ReadinessMarker } from '@/lib/readiness/marker';

const PARALLEL_CHECKS = 3;

export function useReadinessMarkers(user: User, rows: readonly MarkerRow[] | null, capabilities: readonly string[]) {
  const basis = useMemo(() => (rows && capabilities.includes('scope') ? { user, rows, capabilities } : null), [user, rows, capabilities]);
  const [result, setResult] = useState<{ basis: NonNullable<typeof basis>; markers: ReadonlyMap<string, ReadinessMarker> } | null>(null);

  useEffect(() => {
    if (!basis) return;
    const request = basis;
    const controller = new AbortController();
    const { user, rows, capabilities } = basis;
    const editing = rows.filter((row) => row.status === 'draft');
    const markers = new Map<string, ReadinessMarker>();
    let next = 0;
    async function checkRows() {
      while (!controller.signal.aborted) {
        const row = editing[next++];
        if (!row) return;
        const answer = await readReadiness(user, row.id, controller.signal);
        if (controller.signal.aborted) return;
        const marker = readinessMarker(row, answer, capabilities);
        if (marker) {
          markers.set(row.id, marker);
          setResult({ basis: request, markers: new Map(markers) });
        }
      }
    }
    for (let i = 0; i < Math.min(editing.length, PARALLEL_CHECKS); i += 1) void checkRows();
    return () => controller.abort();
  }, [basis]);

  return result?.basis === basis ? result.markers : null;
}
