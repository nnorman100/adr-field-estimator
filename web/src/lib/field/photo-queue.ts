import { meOutcome } from '@/lib/sign-in/outcome';
import { preparePhoto } from './photo';
import {
  addCapture,
  changePhoto,
  readPayload,
  readPendingWork,
  readPhotoQueue,
  requestOriginals,
  type PhotoOwner,
  type PhotoQueueEntry,
  type PhotoTarget,
  type PhotoUpload,
} from './photo-queue-storage';

export { readPendingWork, readPhotoQueue, type PhotoOwner, type PhotoQueueEntry, type PhotoUpload };

const CAPTURE_LOCK = 'ds-photo-capture';
const DRAIN_LOCK = 'ds-photo-drain';
const CAPTURED = 'ds-photo-captured';
const FOREGROUND_INTERVAL_MS = 2_000;
// The photo route allows a request 300 seconds, so a progressing upload may use all of it.
const UPLOAD_DEADLINE_MS = 300_000;
const REFERENCE_DEADLINE_MS = 30_000;
const UNPREPARED_REASON = 'This phone could not prepare a shareable copy of the photo. The full-size original stays on this phone.';
const LOW_STORAGE_BYTES = 50 * 1024 * 1024;

async function sha256Of(bytes: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function capturePhoto(owner: PhotoOwner, target: PhotoTarget, file: Blob): Promise<PhotoQueueEntry> {
  const capturedAt = Date.now();
  const photoId = crypto.randomUUID();
  // Serialise the canvas work across windows to bound image memory on a phone.
  const photo = await navigator.locks.request(CAPTURE_LOCK, async () => {
    const resized = await preparePhoto(file).catch(() => null);
    const original = await file.arrayBuffer();
    const originalSha256 = await sha256Of(original);
    const common = {
      ...owner,
      ...target,
      field: { ...target.field, capturedAt: target.field.capturedAt ?? new Date(capturedAt).toISOString() },
      photoId,
      capturedAt,
      attempts: 0,
      retryAt: 0,
    };
    // The camera's bytes can carry its location, so they are never queued as the shareable photo. Without a
    // resized copy the capture is kept only as a stopped original.
    if (!resized) {
      const entry: PhotoQueueEntry = {
        ...common,
        photoSha256: originalSha256,
        sha256: originalSha256,
        contentType: file.type,
        kind: 'original',
        stage: 'blocked',
        reason: UNPREPARED_REASON,
        requested: false,
      };
      await addCapture([{ entry, data: original }]);
      return entry;
    }
    const data = await resized.arrayBuffer();
    const photoSha256 = await sha256Of(data);
    const entry: PhotoQueueEntry = {
      ...common,
      photoSha256,
      sha256: photoSha256,
      contentType: resized.type,
      kind: 'photo',
      stage: 'queued',
      open: 1,
      requested: true,
    };
    await addCapture([
      { entry, data },
      { entry: { ...entry, kind: 'original', contentType: file.type, sha256: originalSha256, requested: false }, data: original },
    ]);
    return entry;
  });
  window.dispatchEvent(new Event(CAPTURED));
  return photo;
}

export async function photoStorageNearlyFull(): Promise<boolean> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < LOW_STORAGE_BYTES;
  } catch {
    // The estimate is advisory. The capture transaction still reports real quota failures.
    return false;
  }
}

type UploadResult =
  | { kind: 'receipt'; photoId: string; sha256: string }
  | { kind: 'failure'; status: number; reason: string; code?: string; retryAfter?: string | null };
type ReferenceResult = { kind: 'acknowledged' } | { kind: 'blocked'; reason: string } | { kind: 'sign-in' } | { kind: 'retry' };

type PhotoTransport = {
  canSend(): boolean;
  upload(entry: PhotoUpload, bytes: Blob, signal: AbortSignal): Promise<UploadResult>;
  // Call written once the reference is saved locally. After a reopen the reference has the
  // same id, and the acknowledgement must come from the server.
  reference(entry: PhotoQueueEntry, written: () => Promise<void>, signal: AbortSignal): Promise<ReferenceResult>;
  changed?(photoId: string, sending: boolean): void;
  // The server refused the sign-in. The queue stops sending and keeps every entry for the next sign-in.
  signInRequired?(): void;
  storageError?(error: unknown): void;
};

// The refusals the field gate keeps work locked for (sync-gate.ts), by the server's code. A disabled
// member is the owner's definitive stop, and any other refusal belongs to the job.
export function pausesForSignIn(status: number, code?: string): boolean {
  const { kind } = meOutcome(status, { error: code });
  return kind !== 'signed-in' && kind !== 'unavailable' && kind !== 'member-disabled';
}

function retryTime(entry: PhotoQueueEntry, retryAfter?: string | null): number {
  const now = Date.now();
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(entry.attempts, 6));
  const jittered = now + delay * (1 + Math.random() * 0.5);
  if (!retryAfter) return jittered;
  const requested = /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1_000 : Date.parse(retryAfter);
  return Number.isFinite(requested) ? Math.max(jittered, requested) : jittered;
}

// Safari added AbortSignal.any in 17.4. Earlier field browsers still need both aborts.
function attemptSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; release(): void } {
  const deadline = AbortSignal.timeout(ms);
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([parent, deadline]), release() {} };
  const fallback = new AbortController();
  const cancel = () => fallback.abort(parent.aborted ? parent.reason : deadline.reason);
  parent.addEventListener('abort', cancel, { once: true });
  deadline.addEventListener('abort', cancel, { once: true });
  return {
    signal: fallback.signal,
    release() {
      parent.removeEventListener('abort', cancel);
      deadline.removeEventListener('abort', cancel);
    },
  };
}

function readyEntries(entries: PhotoQueueEntry[], now: number): PhotoQueueEntry[] {
  const done = new Set(entries
    .filter((entry) => entry.kind === 'photo' && entry.stage === 'done')
    .map((entry) => JSON.stringify([entry.jobId, entry.photoId])));
  return entries.filter((entry) => {
    if (entry.stage === 'blocked' || entry.stage === 'done' || entry.retryAt > now) return false;
    return entry.kind === 'photo' || (entry.requested && done.has(JSON.stringify([entry.jobId, entry.photoId])));
  });
}

export function startPhotoQueue(owner: PhotoOwner, transport: PhotoTransport) {
  const person = { ...owner };
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let draining = false;
  let signedOut = false;
  const canRun = () => !signal.aborted && !signedOut && document.visibilityState === 'visible' && transport.canSend();
  const lock = () => {
    if (signedOut) return;
    signedOut = true;
    transport.signInRequired?.();
  };

  // Foreground and connection decide when to start an operation. The outcome of one already sent is
  // recorded until the queue is stopped, whatever the page is doing now.
  async function send(entry: PhotoQueueEntry): Promise<void> {
    let current = entry;
    const retry = (retryAfter?: string | null) =>
      changePhoto(current, { attempts: current.attempts + 1, retryAt: retryTime(current, retryAfter) });
    const block = (reason: string) => changePhoto(current, { stage: 'blocked', reason });
    transport.changed?.(entry.photoId, true);
    try {
      if (current.stage === 'queued') {
        const data = await readPayload(current);
        if (!canRun()) return;
        if (!data) {
          await block('The photo bytes could not be read on this phone.');
          return;
        }
        let result: UploadResult;
        const limit = attemptSignal(signal, UPLOAD_DEADLINE_MS);
        try {
          result = await transport.upload(current, new Blob([data], { type: current.contentType }), limit.signal);
        } catch {
          if (!signal.aborted) await retry();
          return;
        } finally {
          limit.release();
        }
        if (signal.aborted) return;
        if (result.kind === 'failure') {
          if (result.status === 0 || result.status === 429 || result.status >= 500) await retry(result.retryAfter);
          else if (pausesForSignIn(result.status, result.code)) lock();
          else await block(result.reason);
          return;
        }
        if (result.photoId !== current.photoId || result.sha256 !== current.sha256) {
          await block('The upload receipt did not match this photo.');
          return;
        }
        const saved = await changePhoto(current, {
          stage: current.kind === 'original' ? 'done' : 'sent',
          attempts: 0,
          retryAt: 0,
        });
        if (!saved || saved.kind === 'original') return;
        current = saved;
      }

      if (!canRun()) return;
      const limit = attemptSignal(signal, REFERENCE_DEADLINE_MS);
      const written = async () => {
        limit.signal.throwIfAborted();
        if (current.stage === 'referenced') return;
        const saved = await changePhoto(current, { stage: 'referenced' });
        if (!saved) throw new Error('The photo queue entry changed.');
        current = saved;
      };
      let result: ReferenceResult;
      try {
        result = await transport.reference(current, written, limit.signal);
      } catch {
        if (!signal.aborted) await retry();
        return;
      } finally {
        limit.release();
      }
      if (signal.aborted) return;
      if (result.kind === 'acknowledged' && current.stage === 'referenced') await changePhoto(current, { stage: 'done' });
      else if (result.kind === 'blocked') await block(result.reason);
      else if (result.kind === 'sign-in') lock();
      else await retry();
    } finally {
      transport.changed?.(entry.photoId, false);
    }
  }

  async function drain(): Promise<void> {
    if (draining || !canRun()) return;
    draining = true;
    try {
      await navigator.locks.request(DRAIN_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        while (canRun()) {
          const entries = readyEntries(await readPendingWork(person), Date.now());
          if (!entries.length) return;
          const work = async () => {
            while (canRun()) {
              const entry = entries.shift();
              if (!entry) return;
              await send(entry);
            }
          };
          // Wait for both workers before releasing the lock, even if one hits a storage error.
          const results = await Promise.allSettled([work(), work()]);
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
        }
      });
    } catch (error) {
      if (!signal.aborted) transport.storageError?.(error);
    } finally {
      draining = false;
    }
  }

  window.addEventListener('online', drain, { signal });
  window.addEventListener('pageshow', drain, { signal });
  window.addEventListener(CAPTURED, drain, { signal });
  document.addEventListener('visibilitychange', drain, { signal });
  const timer = window.setInterval(drain, FOREGROUND_INTERVAL_MS);
  void drain();

  return {
    drain,
    async sendOriginals(jobId: string) {
      if (signal.aborted) return;
      await requestOriginals(person, jobId);
      await drain();
    },
    stop() {
      lifetime.abort();
      window.clearInterval(timer);
    },
  };
}
