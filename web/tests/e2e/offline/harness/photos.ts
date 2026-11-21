import {
  capturePhoto,
  pausesForSignIn,
  photoStorageNearlyFull,
  readPendingWork,
  readPhotoQueue,
  startPhotoQueue,
  type PhotoOwner,
  type PhotoQueueEntry,
  type PhotoUpload,
} from '@/lib/field/photo-queue';

function gpsTaggedJpeg() {
  const exif = new TextEncoder().encode('Exif\0\0GPSLatitude=00.000000;GPSLongitude=00.000000');
  const bytes = new Uint8Array(4 + 2 + exif.length + 2048);
  bytes.set([0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 2]);
  bytes.set(exif, 6);
  bytes.fill(7, 6 + exif.length);
  return bytes;
}

function capture(owner: PhotoOwner, size: [number, number] = [80, 60], jobId = 'job', readable = true) {
  return (async () => {
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = size;
    const drawn = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas did not encode'))), 'image/jpeg');
    });
    // A JPEG header with synthetic location metadata over bytes the canvas cannot decode, so no shareable copy can be made.
    const picture = readable ? drawn : new Blob([gpsTaggedJpeg()], { type: 'image/jpeg' });
    try {
      return await capturePhoto(owner, { jobId, draftId: 'draft', field: { roomId: 'room', shotTag: 'overview' } }, picture);
    } catch (error) {
      return { error: (error as Error).name };
    }
  })();
}

function refusalCode(body: string): string | undefined {
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

function start(owner: PhotoOwner) {
  return startPhotoQueue(owner, {
    canSend: () => networkReady,
    async upload(entry: PhotoUpload, bytes, signal) {
      const response = await fetch(`/upload/${entry.photoId}/${entry.kind}`, {
        method: 'PUT',
        body: bytes,
        signal,
        headers: entry.kind === 'original' ? { 'X-Photo-Sha256': entry.photoSha256 } : undefined,
      });
      if (response.ok) return { kind: 'receipt', ...(await response.json()) };
      const reason = await response.text();
      return {
        kind: 'failure',
        status: response.status,
        reason,
        code: refusalCode(reason),
        retryAfter: response.headers.get('Retry-After'),
      };
    },
    async reference(entry: PhotoQueueEntry, written, signal) {
      await written();
      const response = await fetch(`/reference/${entry.photoId}`, { method: 'PUT', signal });
      if (response.ok) return { kind: 'acknowledged' };
      const reason = await response.text();
      return pausesForSignIn(response.status, refusalCode(reason)) ? { kind: 'sign-in' } : { kind: 'blocked', reason };
    },
    signInRequired() {
      signInRequests += 1;
    },
  });
}

async function bytes() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('ds-queue');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<{ kind: string; size: number; width: number; height: number }[]>((resolve, reject) => {
      const request = db.transaction('bytes').objectStore('bytes').getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        void Promise.all(
          (request.result as { kind: string; data: ArrayBuffer }[]).map(async ({ kind, data }) => {
            const bitmap = await createImageBitmap(new Blob([data])).catch(() => null);
            const result = { kind, size: data.byteLength, width: bitmap?.width ?? 0, height: bitmap?.height ?? 0 };
            bitmap?.close();
            return result;
          }),
        ).then(resolve, reject);
      };
    });
  } finally {
    db.close();
  }
}

// Force the second payload write to fail at the IndexedDB boundary, after the first requests
// have been queued. This works in both engines and exercises the transaction's rollback.
function failSecondPayload() {
  const add = IDBObjectStore.prototype.add;
  let payloads = 0;
  IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
    if (this.name === 'bytes' && ++payloads === 2) throw new DOMException('Disk full', 'QuotaExceededError');
    return add.apply(this, args);
  };
}

let networkReady = false;
let signInRequests = 0;
let queue: ReturnType<typeof start> | undefined;
const deadlines: number[] = [];
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => {
  deadlines.push(ms);
  return timeout(ms);
};
const photoHarness = {
  capture,
  bytes,
  failSecondPayload,
  entries: readPhotoQueue,
  pending: readPendingWork,
  storage: photoStorageNearlyFull,
  open(owner: PhotoOwner, ready = true) {
    queue?.stop();
    networkReady = ready;
    queue = start(owner);
  },
  ready() {
    networkReady = true;
    window.dispatchEvent(new Event('online'));
  },
  originals(jobId = 'job') {
    return queue?.sendOriginals(jobId);
  },
  signInRequests: () => signInRequests,
  timeouts() {
    return deadlines;
  },
  show(visible: boolean) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
    document.dispatchEvent(new Event('visibilitychange'));
  },
};

declare global {
  interface Window {
    photoHarness: typeof photoHarness;
  }
}

window.photoHarness = photoHarness;
