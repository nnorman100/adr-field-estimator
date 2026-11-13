// Adds the owner's meter photos to the S7-5 meter-reading dataset (web/tests/ai-evals/README.md,
// "Audio and photos"). Take each shot in web/tests/ai-evals/data/meter-photos.jsonl, name it by its
// id (mp-01.jpg or mp-01.png), strip its metadata, and put them in one folder. From web/:
//
//   npm run eval:photos -- --from <folder>
//
// Each photo must be a JPEG or PNG of at most 4 MB with no metadata block (an Exif block can hold
// GPS coordinates, which never go into git). It copies the good ones in, records their SHA-256 in
// the manifest and prints counts only. No model call; nothing leaves the machine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR, loadDataset } from '../tests/ai-evals/datasets';
import { photoProblem, readIfPresent, sha256, updateManifest } from '../tests/ai-evals/files';

export class PhotoArgsError extends Error {}

export function parsePhotoArgs(argv: string[]): { from: string } {
  if (argv.length !== 2 || argv[0] !== '--from' || !argv[1]) throw new PhotoArgsError('usage: --from <folder>');
  return { from: argv[1] };
}

export type PhotoCounts = { added: number; missing: number; refused: Record<string, number> };

export function addPhotos(
  from: string,
  io: { read(path: string): Uint8Array | null; write(target: string, bytes: Uint8Array): void },
): { counts: PhotoCounts; changes: Map<string, { file: string; sha256: string }> } {
  const counts: PhotoCounts = { added: 0, missing: 0, refused: {} };
  const changes = new Map<string, { file: string; sha256: string }>();
  for (const photo of loadDataset('meterPhotos')) {
    const found = ['jpg', 'png']
      .map((ext) => ({ ext, bytes: io.read(join(from, `${photo.id}.${ext}`)) }))
      .find((candidate) => candidate.bytes !== null);
    if (!found) {
      counts.missing += 1;
      continue;
    }
    const problem = photoProblem(found.bytes!);
    if (problem) {
      counts.refused[problem] = (counts.refused[problem] ?? 0) + 1;
      continue;
    }
    const file = `meter-photos/${photo.id}.${found.ext}`;
    // The checked bytes are what gets written, so the stored file is the one that passed.
    io.write(`${DATA_DIR}${file}`, found.bytes!);
    changes.set(photo.id, { file, sha256: sha256(found.bytes!) });
    counts.added += 1;
  }
  return { counts, changes };
}

function main() {
  const { from } = parsePhotoArgs(process.argv.slice(2));
  mkdirSync(`${DATA_DIR}meter-photos`, { recursive: true });
  const { counts, changes } = addPhotos(from, { read: readIfPresent, write: writeFileSync });
  if (changes.size > 0) updateManifest('meterPhotos', changes);
  console.log(JSON.stringify(counts));
  return counts.missing === 0 && Object.keys(counts.refused).length === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main() ? 0 : 1);
  } catch (error) {
    console.error(error instanceof PhotoArgsError ? error.message : 'adding photos failed');
    process.exit(2);
  }
}
