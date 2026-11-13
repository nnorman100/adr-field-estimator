// Draws the 60 S7-5 meter photos (web/tests/ai-evals/README.md, "Audio and photos") from the shot
// list in web/tests/ai-evals/data/meter-photos.jsonl: 40 readable meters showing their value and
// unit on a seven-segment display, and 20 unreadable shots showing the problem the row names
// (blank, glare, blur, cut off, face down, no meter, thumb, too dark, motion blur, dashes).
// Deterministic: no model, no camera, no randomness, so the same rows always give the same bytes.
// Plain PNG with no metadata chunk, well under Model Armor's 4 MB. From web/:
//
//   npm run eval:photos
//
// It writes each image as meter-photos/<id>.png beside the manifest, records its SHA-256 there
// and prints counts only. Commit the images and the manifest.
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { DATA_DIR, loadDataset, type MeterPhoto } from '../tests/ai-evals/datasets';
import { photoProblem, sha256, updateManifest } from '../tests/ai-evals/files';

export const WIDTH = 320;
export const HEIGHT = 240;

type Rgb = readonly [number, number, number];
type Image = { width: number; height: number; rgb: Uint8Array };

// ---- PNG: signature, IHDR (8-bit RGB), one IDAT, IEND. No other chunk, so no metadata.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.byteLength, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function pngFile({ width, height, rgb }: Image): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB, deflate, no filter method change, no interlace
  // Each row: filter type 1 (Sub), each byte less the byte one pixel to its left.
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (stride + 1)] = 1;
    for (let x = 0; x < stride; x += 1) {
      const value = rgb[y * stride + x]!;
      const left = x >= 3 ? rgb[y * stride + x - 3]! : 0;
      rows[y * (stride + 1) + 1 + x] = (value - left) & 0xff;
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(
    Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', new Uint8Array(0))]),
  );
}

// ---- Drawing.
class Canvas {
  readonly rgb: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    fill: Rgb,
  ) {
    this.rgb = new Uint8Array(width * height * 3);
    this.rect(0, 0, width, height, fill);
  }

  blend(x: number, y: number, color: Rgb, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = (y * this.width + x) * 3;
    for (let i = 0; i < 3; i += 1) this.rgb[at + i] = Math.round(this.rgb[at + i]! * (1 - alpha) + color[i]! * alpha);
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb, alpha = 1) {
    for (let j = Math.max(0, Math.round(y)); j < Math.min(this.height, Math.round(y + h)); j += 1) {
      for (let i = Math.max(0, Math.round(x)); i < Math.min(this.width, Math.round(x + w)); i += 1) this.blend(i, j, color, alpha);
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: Rgb, alpha = 1) {
    for (let j = Math.floor(cy - ry); j <= Math.ceil(cy + ry); j += 1) {
      for (let i = Math.floor(cx - rx); i <= Math.ceil(cx + rx); i += 1) {
        if (((i - cx) / rx) ** 2 + ((j - cy) / ry) ** 2 <= 1) this.blend(i, j, color, alpha);
      }
    }
  }

  // A box blur, `passes` times, horizontally only or both ways.
  blur(radius: number, passes: number, vertical = true) {
    const pass = (horizontal: boolean) => {
      const out = new Uint8Array(this.rgb.length);
      for (let y = 0; y < this.height; y += 1) {
        for (let x = 0; x < this.width; x += 1) {
          const sum = [0, 0, 0];
          let n = 0;
          for (let d = -radius; d <= radius; d += 1) {
            const sx = horizontal ? Math.min(this.width - 1, Math.max(0, x + d)) : x;
            const sy = horizontal ? y : Math.min(this.height - 1, Math.max(0, y + d));
            const at = (sy * this.width + sx) * 3;
            for (let i = 0; i < 3; i += 1) sum[i]! += this.rgb[at + i]!;
            n += 1;
          }
          const at = (y * this.width + x) * 3;
          for (let i = 0; i < 3; i += 1) out[at + i] = Math.round(sum[i]! / n);
        }
      }
      this.rgb.set(out);
    };
    for (let p = 0; p < passes; p += 1) {
      pass(true);
      if (vertical) pass(false);
    }
  }

  scale(factor: number) {
    for (let i = 0; i < this.rgb.length; i += 1) this.rgb[i] = Math.round(this.rgb[i]! * factor);
  }
}

// Seven segments: a top, b upper right, c lower right, d bottom, e lower left, f upper left, g middle.
const SEGMENTS: Readonly<Record<string, string>> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  '-': 'g',
};

function digit(canvas: Canvas, x: number, y: number, w: number, h: number, char: string, color: Rgb) {
  const t = Math.max(2, Math.round(w / 5));
  const half = h / 2;
  const parts: Record<string, [number, number, number, number]> = {
    a: [x + t, y, w - 2 * t, t],
    b: [x + w - t, y + t, t, half - t],
    c: [x + w - t, y + half, t, half - t],
    d: [x + t, y + h - t, w - 2 * t, t],
    e: [x, y + half, t, half - t],
    f: [x, y + t, t, half - t],
    g: [x + t, y + half - t / 2, w - 2 * t, t],
  };
  for (const segment of SEGMENTS[char] ?? '') canvas.rect(...parts[segment]!, color);
}

// A 5 by 7 pixel font for the units on the display.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '%': ['11..1', '11.1.', '...1.', '..1..', '.1...', '.1.11', '1..11'],
  M: ['1...1', '11.11', '1.1.1', '1.1.1', '1...1', '1...1', '1...1'],
  C: ['.111.', '1...1', '1....', '1....', '1....', '1...1', '.111.'],
  R: ['1111.', '1...1', '1...1', '1111.', '1.1..', '1..1.', '1...1'],
  H: ['1...1', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
  F: ['11111', '1....', '1....', '1111.', '1....', '1....', '1....'],
  E: ['11111', '1....', '1....', '1111.', '1....', '1....', '11111'],
  L: ['1....', '1....', '1....', '1....', '1....', '1....', '11111'],
  '°': ['.11..', '1..1.', '1..1.', '.11..', '.....', '.....', '.....'],
};

function text(canvas: Canvas, x: number, y: number, size: number, value: string, color: Rgb) {
  [...value].forEach((char, k) => {
    (GLYPHS[char] ?? []).forEach((row, j) => {
      [...row].forEach((on, i) => {
        if (on === '1') canvas.rect(x + (k * 6 + i) * size, y + j * size, size, size, color);
      });
    });
  });
}

// The display: the value in seven segments (a decimal point between digits), the unit beneath.
function display(canvas: Canvas, x: number, y: number, w: number, h: number, shown: string | null, unit: string | null, ink: Rgb, lcd: Rgb) {
  canvas.rect(x, y, w, h, lcd);
  if (shown === null) return;
  const digits = [...shown].filter((c) => c !== '.');
  const dh = Math.round(h * 0.55);
  const dw = Math.round(dh * 0.5);
  const gap = Math.round(dw * 0.4);
  const total = digits.length * dw + (digits.length - 1) * gap;
  let at = x + Math.round((w - total) / 2);
  const top = y + Math.round(h * 0.1);
  for (const char of shown) {
    if (char === '.') {
      const dot = Math.max(3, Math.round(dw / 5));
      canvas.rect(at - gap / 2 - dot / 2, top + dh - dot, dot, dot, ink);
      continue;
    }
    digit(canvas, at, top, dw, dh, char, ink);
    at += dw + gap;
  }
  if (unit) {
    const size = Math.max(1, Math.round(h / 28));
    const unitText = unit === 'F' ? '°F' : unit;
    text(canvas, x + w - unitText.length * 6 * size - Math.round(w * 0.06), y + h - 9 * size, size, unitText, ink);
  }
}

const BODY: Readonly<Record<string, Rgb>> = {
  'pinless moisture meter': [38, 58, 92],
  'pin moisture meter': [196, 112, 34],
  'thermo-hygrometer': [70, 72, 76],
};
const SKIN: Rgb = [205, 150, 120];
const INK: Rgb = [28, 34, 30];
const LCD: Rgb = [176, 196, 170];

type Scene = { background: Rgb; scale: number; dx: number; dy: number; hand?: boolean; floor?: boolean; flash?: boolean };

function scene(photo: MeterPhoto, index: number): Scene {
  const jitter = (n: number) => ((index * 37 + n * 11) % 21) - 10;
  const tint = (base: Rgb): Rgb => [base[0] + jitter(1), base[1] + jitter(2), base[2] + jitter(3)];
  if (photo.shot.startsWith('close-up')) return { background: tint([120, 116, 108]), scale: 1.35, dx: jitter(4), dy: jitter(5) };
  if (photo.shot.startsWith('held at arm length')) return { background: tint([150, 160, 170]), scale: 0.75, dx: jitter(4) * 3, dy: jitter(5) * 2 };
  if (photo.shot.startsWith('in hand')) return { background: tint([186, 160, 130]), scale: 0.95, dx: jitter(4), dy: jitter(5), hand: true };
  if (photo.shot.startsWith('resting on drywall')) return { background: tint([228, 226, 218]), scale: 1, dx: jitter(4) * 2, dy: jitter(5) };
  if (photo.shot.startsWith('on a baseboard')) return { background: tint([210, 206, 196]), scale: 0.9, dx: jitter(4), dy: 20, floor: true, flash: true };
  return { background: tint([160, 150, 140]), scale: 1, dx: 0, dy: 0, floor: true };
}

// The meter: body, display, and for a pin meter its pins.
function meter(canvas: Canvas, photo: MeterPhoto, s: Scene, shown: string | null, ink: Rgb = INK, lcd: Rgb = LCD) {
  const w = 150 * s.scale;
  const h = 200 * s.scale;
  const x = (WIDTH - w) / 2 + s.dx;
  const y = (HEIGHT - h) / 2 + s.dy;
  const body = BODY[photo.meter] ?? BODY['thermo-hygrometer']!;
  if (photo.meter === 'pin moisture meter') {
    canvas.rect(x + w * 0.3, y - 18 * s.scale, 4 * s.scale, 20 * s.scale, [190, 190, 190]);
    canvas.rect(x + w * 0.65, y - 18 * s.scale, 4 * s.scale, 20 * s.scale, [190, 190, 190]);
  }
  canvas.rect(x, y, w, h, body);
  canvas.rect(x + w * 0.08, y + h * 0.08, w * 0.84, h * 0.42, [20, 22, 24]);
  display(canvas, x + w * 0.11, y + h * 0.11, w * 0.78, h * 0.36, shown, photo.unit, ink, lcd);
  canvas.ellipse(x + w * 0.3, y + h * 0.72, w * 0.1, w * 0.1, [200, 200, 200]);
  canvas.ellipse(x + w * 0.7, y + h * 0.72, w * 0.1, w * 0.1, [200, 200, 200]);
  return { x, y, w, h, display: { x: x + w * 0.11, y: y + h * 0.11, w: w * 0.78, h: h * 0.36 } };
}

export function renderMeterPhoto(photo: MeterPhoto, index: number): Image {
  const s = scene(photo, index);
  const canvas = new Canvas(WIDTH, HEIGHT, s.background);
  if (s.floor) canvas.rect(0, HEIGHT * 0.78, WIDTH, HEIGHT * 0.22, [150, 120, 90]);
  const shot = photo.shot;
  if (photo.readable) {
    const placed = meter(canvas, photo, s, photo.value);
    if (s.hand) canvas.ellipse(placed.x - 6, placed.y + placed.h * 0.8, 40, 60, SKIN);
    if (s.flash) canvas.ellipse(placed.x + placed.w * 0.5, placed.y + placed.h * 0.8, 30, 14, [255, 255, 255], 0.8);
  } else if (shot === 'no meter in the frame') {
    canvas.rect(0, HEIGHT * 0.7, WIDTH, HEIGHT * 0.3, [150, 120, 90]);
    canvas.rect(0, HEIGHT * 0.64, WIDTH, HEIGHT * 0.06, [240, 238, 232]);
  } else if (shot === 'meter face down on the floor') {
    canvas.rect(0, 0, WIDTH, HEIGHT, [s.background[0] - 10, s.background[1] - 30, s.background[2] - 50]);
    const back = BODY[photo.meter] ?? BODY['thermo-hygrometer']!;
    canvas.rect(85 + s.dx, 40 + s.dy, 150, 160, [back[0] * 0.7, back[1] * 0.7, back[2] * 0.7]);
    canvas.rect(130 + s.dx, 90 + s.dy, 60, 40, [40, 40, 40]);
  } else if (shot === 'display cut off by the frame') {
    meter(canvas, photo, { ...s, dx: 175, dy: -40 }, '88.8');
  } else if (shot === 'display is blank') {
    meter(canvas, photo, s, null);
  } else if (shot === 'display shows only dashes') {
    meter(canvas, photo, s, '--.-');
  } else if (shot === 'too dark to read') {
    meter(canvas, photo, s, '47.5', [70, 74, 72], [78, 82, 80]);
    canvas.scale(0.06);
  } else {
    const placed = meter(canvas, photo, s, index % 2 === 0 ? '47.5' : '63.1');
    const d = placed.display;
    if (shot === 'strong glare covers the digits') canvas.ellipse(d.x + d.w / 2, d.y + d.h / 2, d.w * 0.62, d.h * 0.7, [255, 255, 252]);
    else if (shot === 'thumb covers the display') canvas.ellipse(d.x + d.w / 2, d.y + d.h / 2 + 6, d.w * 0.6, d.h * 0.75, SKIN);
    else if (shot === 'out of focus') canvas.blur(9, 3);
    else if (shot === 'motion blur') canvas.blur(24, 2, false);
    else throw new Error(`no drawing for shot "${shot}"`);
  }
  return { width: canvas.width, height: canvas.height, rgb: canvas.rgb };
}

// Every photo's PNG bytes and its manifest change.
export function renderAll(photos: readonly MeterPhoto[]) {
  return photos.map((photo, index) => {
    const bytes = pngFile(renderMeterPhoto(photo, index));
    const problem = photoProblem(bytes);
    if (problem) throw new Error(`${photo.id}: ${problem}`);
    return { id: photo.id, file: `meter-photos/${photo.id}.png`, bytes, sha256: sha256(bytes) };
  });
}

function main() {
  if (process.argv.length > 2) throw new Error('this command takes no arguments');
  const rendered = renderAll(loadDataset('meterPhotos'));
  mkdirSync(`${DATA_DIR}meter-photos`, { recursive: true });
  for (const photo of rendered) writeFileSync(`${DATA_DIR}${photo.file}`, photo.bytes);
  updateManifest('meterPhotos', new Map(rendered.map((p) => [p.id, { file: p.file, sha256: p.sha256 }])));
  console.log(JSON.stringify({ rendered: rendered.length, bytes: rendered.reduce((n, p) => n + p.bytes.byteLength, 0) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'rendering failed');
    process.exit(1);
  }
}
