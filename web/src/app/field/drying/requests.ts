'use client';

import type { User } from 'firebase/auth';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReadingInput } from '@/lib/drying/schema';
import { callApi, type ApiAnswer } from '@/lib/firebase-client';

export type DryingContext = {
  user: User;
  jobId: string;
  // The sign-in, company, actor and job this card belongs to; unsent input is kept only under it.
  scope: string;
  isCurrent: () => boolean;
  visible: boolean;
  online: boolean;
  canAdd: boolean;
  office: boolean;
  // The job is archived, refused or being verified: fetched data is hidden, unsent input stays.
  blocked?: boolean;
  // Changes when the job's status or draft changes, so the watch is read again.
  refreshOn?: string;
  // The field screen's Back to Finish guard and readiness recheck, when it has them.
  markUnsaved?: (form: string, discard: (() => void) | null, unsaved?: boolean) => void;
  startSave?: () => (failed?: boolean) => void;
  changed?: () => void;
};

export type DryingSession = DryingContext & {
  refused: boolean;
  // `ambiguous` marks a 404 that may only mean the feature is off: the screen rechecks job access.
  onRefused: (status: number, ambiguous?: boolean) => void;
};

const unsentReadings = new Map<string, ReadingInput>();
// The exact reading request (and its id) of a save with no answer yet, until it is resolved.
export const unsent = {
  get: (scope: string) => unsentReadings.get(scope) ?? null,
  set: (scope: string, reading: ReadingInput) => void unsentReadings.set(scope, reading),
  clear: (scope: string) => void unsentReadings.delete(scope),
};

export const dryingPath = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}`;

export const accessRefused = (status: number) => [401, 403, 404, 410].includes(status);

export async function dryingRequest(
  user: User,
  path: string,
  signal?: AbortSignal,
  json?: unknown,
): Promise<ApiAnswer> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) return { status: 0, body: null };
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = window.setTimeout(cancel, 15_000);
  const unavailable = new Promise<ApiAnswer>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve({ status: 0, body: null }), {
      once: true,
    });
  });
  try {
    return await Promise.race([
      unavailable,
      callApi(user, path, {
        signal: controller.signal,
        ...(json !== undefined ? { method: 'POST', json } : {}),
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

type Result<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'refused'; status: number }
  | { kind: 'retry' };

type Read<T> = (user: User, jobId: string, signal: AbortSignal) => Promise<Result<T>>;

// Each card owns its reads. A new visibility period, retry, or request supersedes any older read.
export function useDryingRead<T>(
  session: DryingSession,
  enabled: boolean,
  read: Read<T>,
  changes: number | string = 0,
  ambiguousNotFound = false,
) {
  const { user, jobId, isCurrent, visible, online, refused, onRefused } = session;
  const [result, setResult] = useState<Result<T>>({ kind: 'loading' });
  const available = enabled && online && !refused;
  if ((!available || !visible) && result.kind === 'ready') setResult({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  const request = useRef<AbortController | null>(null);
  const suspend = useCallback(() => request.current?.abort(), []);
  const replace = useCallback(
    (next: Result<T>) => {
      suspend();
      setResult(next);
    },
    [suspend],
  );
  const refresh = useCallback(() => {
    replace({ kind: 'loading' });
    setVersion((value) => value + 1);
  }, [replace]);

  useLayoutEffect(() => suspend, [visible, available, suspend]);
  useEffect(() => {
    if (!available || !visible) return;
    function forget() {
      suspend();
      setResult({ kind: 'loading' });
    }
    async function load() {
      suspend();
      if (document.visibilityState !== 'visible' || !navigator.onLine || !isCurrent()) return;
      const current = new AbortController();
      request.current = current;
      const answer = await read(user, jobId, current.signal);
      if (current.signal.aborted || !isCurrent()) return;
      setResult(answer);
      if (answer.kind === 'refused') onRefused(answer.status, ambiguousNotFound && answer.status === 404);
    }
    function shown() {
      if (document.visibilityState === 'visible') void load();
      else forget();
    }
    function restored(event: PageTransitionEvent) {
      if (event.persisted) {
        forget();
        void load();
      }
    }
    void load();
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('pageshow', restored);
    window.addEventListener('pagehide', forget);
    return () => {
      suspend();
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('pageshow', restored);
      window.removeEventListener('pagehide', forget);
    };
  }, [user, jobId, isCurrent, visible, available, read, changes, version, suspend, onRefused, ambiguousNotFound]);

  const current: Result<T> = refused ? { kind: 'refused', status: 403 } : result;
  return { result: current, refresh, setResult: replace };
}

export function readFailure(status: number): Result<never> {
  return accessRefused(status) ? { kind: 'refused', status } : { kind: 'retry' };
}

export function useBrowserOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
