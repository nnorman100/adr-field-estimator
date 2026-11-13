import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { datasetPath, loadDataset, type DatasetName } from './datasets';

// The binary half of the S7-5 datasets: voice-note and Live-turn audio (spoken by the Live model,
// web/scripts/make-eval-audio.ts) and meter photos (taken by the owner, web/scripts/add-eval-photos.ts).
// Pure helpers, so CI tests them without a model or a camera.

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Live replies are 16-bit little-endian PCM at 24 kHz (documents/docs.cloud.google.com/
// gemini-enterprise-agent-platform/models/live-api). Stored at 16 kHz, the rate the phone and the
// Live input use, to keep the committed files small. Linear interpolation is enough for speech.
export function resample24kTo16k(pcm24k: Uint8Array): Uint8Array {
  const input = new Int16Array(pcm24k.buffer.slice(pcm24k.byteOffset, pcm24k.byteOffset + (pcm24k.byteLength & ~1)));
  const length = Math.floor((input.length * 2) / 3);
  const output = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const at = (i * 3) / 2;
    const left = Math.floor(at);
    const right = Math.min(left + 1, input.length - 1);
    output[i] = Math.round(input[left]! + (input[right]! - input[left]!) * (at - left));
  }
  return new Uint8Array(output.buffer);
}

// A mono 16-bit PCM WAV file.
export function wavFile(pcm: Uint8Array, rate = 16_000): Uint8Array {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // Model Armor's image limit (documents/docs.cloud.google.com/model-armor/screen-images)

// Why a meter photo cannot join the dataset, or null. JPEG or PNG only, at most 4 MB, and no
// embedded metadata: an Exif block can carry GPS coordinates, which never go into git (hard rule 6).
export function photoProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return 'not between 1 byte and 4 MB';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.byteLength && bytes[at] === 0xff) {
      const marker = bytes[at + 1]!;
      if (marker === 0xda) return null; // image data starts; no metadata segment came before it
      if (marker === 0xe1) return 'has an Exif or XMP block (strip metadata first)';
      at += 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
    }
    return 'not a readable JPEG';
  }
  if ([0x89, 0x50, 0x4e, 0x47].every((byte, i) => bytes[i] === byte)) {
    let at = 8;
    while (at + 8 <= bytes.byteLength) {
      const length = Buffer.from(bytes.subarray(at, at + 4)).readUInt32BE(0);
      const type = Buffer.from(bytes.subarray(at + 4, at + 8)).toString('ascii');
      if (['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(type)) return 'has a metadata chunk (strip metadata first)';
      if (type === 'IEND') return null;
      at += 12 + length;
    }
    return 'not a readable PNG';
  }
  return 'not a JPEG or PNG';
}

// Rewrites a manifest with new file names and hashes, keeping every other field and the order.
export function updateManifest(name: DatasetName, changes: ReadonlyMap<string, { file: string; sha256: string }>) {
  const rows = loadDataset(name) as ({ id: string; file: string; sha256: string | null } & Record<string, unknown>)[];
  const lines = rows.map((row) => JSON.stringify({ ...row, ...(changes.get(row.id) ?? {}) }));
  writeFileSync(datasetPath(name), `${lines.join('\n')}\n`);
  loadDataset(name); // the result still matches its schema
}

export function readIfPresent(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
