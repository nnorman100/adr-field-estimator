import { createHash } from 'node:crypto';

// The bytes of a photo (S5a-5): what is accepted, how it is read from a request, and its hash.

// Under Cloud Run's 32 MiB limit on an HTTP/1 request (docs.cloud.google.com/run/quotas), with room
// for headers. The phone's 2,560 px copy is a few MiB; the cap is for the full-size original.
export const MAX_PHOTO_BYTES = 30 * 1024 * 1024;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

const startsWith = (bytes: Uint8Array, at: number, signature: readonly number[]) =>
  bytes.length >= at + signature.length && signature.every((value, index) => bytes[at + index] === value);

// What the bytes are, from their own first bytes, never from the Content-Type the caller sent: the
// stored type is one of three fixed values and is what a later read answers with. null when the
// bytes are none of JPEG, PNG or WebP (the old app's list; convert anything else first).
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export class TooLarge extends Error {}

// The whole body as bytes, refusing one over `limit` as soon as it is known to be: from the
// declared length before reading, and from the running total while reading (a body with no or a
// wrong length cannot get past the limit either).
export async function readBody(request: Request, limit = MAX_PHOTO_BYTES): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) throw new TooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new TooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, total);
}
