import {
  capturePhoto,
  pausesForSignIn,
  photoStorageNearlyFull,
  readPendingWork,
  readPhotoQueue,
  retriesLater,
  startPhotoQueue,
  type PhotoOwner,
  type PhotoQueueEntry,
  type PhotoUpload,
} from '@/lib/field/photo-queue';

function drawn(size: [number, number]) {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = size;
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas did not encode'))), 'image/jpeg');
  });
}

// A decodable JPEG with an EXIF segment whose TIFF directory holds a GPS directory of synthetic
// coordinates (0 degrees north, 0 degrees east), as a phone camera writes it.
async function gpsJpeg(): Promise<Uint8Array> {
  const picture = new Uint8Array(await (await drawn([80, 60])).arrayBuffer());
  const tiff = new DataView(new ArrayBuffer(128));
  const ascii = (offset: number, text: string) => [...text].forEach((c, i) => tiff.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'MM');
  tiff.setUint16(2, 42);
  tiff.setUint32(4, 8);
  tiff.setUint16(8, 1);
  tiff.setUint16(10, 0x8825);
  tiff.setUint16(12, 4);
  tiff.setUint32(14, 1);
  tiff.setUint32(18, 26);
  tiff.setUint32(22, 0);
  tiff.setUint16(26, 4);
  const entry = (at: number, tag: number, type: number, count: number) => {
    tiff.setUint16(at, tag);
    tiff.setUint16(at + 2, type);
    tiff.setUint32(at + 4, count);
  };
  entry(28, 1, 2, 2);
  ascii(36, 'N');
  entry(40, 2, 5, 3);
  tiff.setUint32(48, 80);
  entry(52, 3, 2, 2);
  ascii(60, 'E');
  entry(64, 4, 5, 3);
  tiff.setUint32(72, 104);
  for (const at of [80, 88, 96, 104, 112, 120]) tiff.setUint32(at + 4, 1);
  const payload = new Uint8Array(6 + tiff.byteLength);
  payload.set(new TextEncoder().encode('Exif\0\0'));
  payload.set(new Uint8Array(tiff.buffer), 6);
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  segment.set(payload, 4);
  return Uint8Array.from([...picture.slice(0, 2), ...segment, ...picture.slice(2)]);
}

async function sha256Hex(data: BufferSource) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function capture(owner: PhotoOwner, size: [number, number] = [80, 60], jobId = 'job') {
  return (async () => {
    const picture = await drawn(size);
    try {
      return await capturePhoto(owner, { jobId, draftId: 'draft', field: { roomId: 'room', shotTag: 'overview' } }, picture);
    } catch (error) {
      return { error: (error as Error).name };
    }
  })();
}

// Captures the GPS-tagged JPEG while canvas encoding fails after the picture decoded, so no shareable copy can be made.
async function captureGps(owner: PhotoOwner, jobId = 'job') {
  const fixture = await gpsJpeg();
  const toBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (callback) {
    callback(null);
  };
  try {
    const entry = await capturePhoto(
      owner,
      { jobId, draftId: 'draft', field: { roomId: 'room', shotTag: 'overview' } },
      new Blob([fixture], { type: 'image/jpeg' }),
    );
    return { entry, fixtureSha256: await sha256Hex(fixture) };
  } finally {
    HTMLCanvasElement.prototype.toBlob = toBlob;
  }
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
      const code = refusalCode(reason);
      if (retriesLater(response.status, code)) return { kind: 'retry' };
      return pausesForSignIn(response.status, code) ? { kind: 'sign-in' } : { kind: 'blocked', reason };
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
    return await new Promise<{ kind: string; size: number; width: number; height: number; sha256: string }[]>((resolve, reject) => {
      const request = db.transaction('bytes').objectStore('bytes').getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        void Promise.all(
          (request.result as { kind: string; data: ArrayBuffer }[]).map(async ({ kind, data }) => {
            const bitmap = await createImageBitmap(new Blob([data])).catch(() => null);
            const result = { kind, size: data.byteLength, width: bitmap?.width ?? 0, height: bitmap?.height ?? 0, sha256: await sha256Hex(data) };
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
  captureGps,
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
