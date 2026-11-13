import { describe, expect, it } from 'vitest';
import { attemptBoundMicroUsd, liveUsage, type Attempt, type Speaker } from '@/lib/ai/eval-speech';
import { readFileSync } from 'node:fs';
import { AudioArgsError, checkAudioEnv, makeAudio, matchesScript, MAX_MICRO_USD, VOICES } from '../../scripts/make-eval-audio';
import { pngFile, renderAll, renderMeterPhoto } from '../../scripts/render-eval-photos';
import { DATA_DIR, loadDataset } from '../ai-evals/datasets';
import { photoProblem, resample24kTo16k, sha256, wavFile } from '../ai-evals/files';

// The S7-5 binary datasets: Live-model speech for voice notes and Live turns, and the owner's meter
// photos. Fakes only: the speaker and the file system are ports.

const pcm = (samples: number[]) => new Uint8Array(new Int16Array(samples).buffer);

describe('audio files', () => {
  it('resamples 24 kHz to 16 kHz by two thirds, keeping the waveform', () => {
    const out = new Int16Array(resample24kTo16k(pcm([0, 300, 600, 900, 1200, 1500])).buffer);
    expect([...out]).toEqual([0, 450, 900, 1350]);
  });

  it('writes a mono 16-bit PCM WAV header', () => {
    const wav = Buffer.from(wavFile(pcm([1, 2, 3])));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.byteLength).toBe(50);
  });
});

describe('make-eval-audio', () => {
  it('is owner-run only: refuses CI, Actions, Cloud Run and any argument', () => {
    for (const name of ['CI', 'GITHUB_ACTIONS', 'K_SERVICE', 'CLOUD_RUN_JOB']) {
      expect(() => checkAudioEnv([], { [name]: '1' })).toThrow(AudioArgsError);
    }
    expect(() => checkAudioEnv(['--project', 'x'], {})).toThrow(/no arguments/);
    expect(() => checkAudioEnv([], {})).not.toThrow();
  });

  const NOW = () => new Date('2026-11-13T12:00:00Z');
  const spoken = (text: string, outputTokens = 100): Attempt => ({
    spoken: { pcm24k: pcm([0, 100, 200, 300, 400, 500]), transcript: text },
    usage: { input: { text: 20 }, output: { audio: outputTokens } },
  });
  const io = () => {
    const files = new Map<string, Uint8Array>();
    const recorded: [string, Map<string, { file: string; sha256: string }>][] = [];
    return {
      files,
      recorded,
      read: (path: string) => files.get(path) ?? null,
      write: (path: string, bytes: Uint8Array) => void files.set(path, bytes),
      record: (name: 'voiceNotes' | 'liveTurns', changes: Map<string, { file: string; sha256: string }>) => void recorded.push([name, changes]),
    };
  };
  const VN01 =
    'Kitchen note. The supply line under the sink failed overnight. I pulled the toe kick and the subfloor is reading twenty eight percent near the dishwasher.';
  const items = [
    { id: 'vn-01', text: VN01, terms: ['toe kick', 'subfloor', 'dishwasher'], file: 'voice-notes/vn-01.wav', sha256: null },
    { id: 'vn-02', text: 'Drywall is wet behind the vanity.', terms: ['drywall', 'vanity'], file: 'voice-notes/vn-02.wav', sha256: null },
  ];

  it('keeps clips whose spoken words match the script, rotating voices, and records their hashes', async () => {
    const voices: string[] = [];
    const speaker: Speaker = { speak: async (text, voice) => (voices.push(voice), spoken(text.replace('twenty eight', '28'))) };
    const files = io();
    const counts = await makeAudio([{ name: 'voiceNotes', items }], speaker, files);
    expect(counts).toMatchObject({ kept: 2, skipped: 0, mismatched: 0, failed: 0, stopped: false });
    expect(voices).toEqual([VOICES[0], VOICES[1]]);
    const written = files.files.get(`${DATA_DIR}voice-notes/vn-01.wav`)!;
    expect(Buffer.from(written).toString('ascii', 0, 4)).toBe('RIFF');
    expect(files.recorded[0]![1].get('vn-01')).toEqual({ file: 'voice-notes/vn-01.wav', sha256: sha256(written) });
  });

  it('retries a clip once when the model strays from the script, and drops it if it strays again', async () => {
    let calls = 0;
    const speaker: Speaker = { speak: async (text) => spoken(calls++ < 3 ? 'something else was said here' : text) };
    const files = io();
    const counts = await makeAudio([{ name: 'voiceNotes', items }], speaker, files);
    expect(counts).toMatchObject({ kept: 1, mismatched: 1 });
    expect(files.recorded[0]![1].has('vn-01')).toBe(false);
    expect(files.recorded[0]![1].has('vn-02')).toBe(true);
  });

  it('drops a clip whose numbers or labelled terms differ from the script, even with few word errors', async () => {
    expect(matchesScript(items[0]!, VN01)).toBe(true);
    expect(matchesScript(items[0]!, VN01.replace('twenty eight', '28'))).toBe(true);
    expect(matchesScript(items[0]!, VN01.replace('twenty eight', 'twenty nine'))).toBe(false);
    expect(matchesScript(items[0]!, VN01.replace('Kitchen note.', 'Kitchen note 2.'))).toBe(false);
    expect(matchesScript(items[0]!, VN01.replace('dishwasher', 'washer'))).toBe(false);
    const speaker: Speaker = { speak: async (text) => spoken(text.replace('twenty eight', 'twenty nine')) };
    const files = io();
    const counts = await makeAudio([{ name: 'voiceNotes', items }], speaker, files, NOW);
    expect(counts).toMatchObject({ kept: 1, mismatched: 1 });
    expect(files.files.has(`${DATA_DIR}voice-notes/vn-01.wav`)).toBe(false);
  });

  it('skips files already there with their hash', async () => {
    const files = io();
    const wav = wavFile(pcm([1]));
    files.files.set(`${DATA_DIR}voice-notes/vn-01.wav`, wav);
    const speak = async (): Promise<Attempt> => ({ spoken: null, usage: null });
    const skipped = await makeAudio([{ name: 'voiceNotes', items: [{ ...items[0]!, sha256: sha256(wav) }] }], { speak }, files, NOW);
    expect(skipped).toMatchObject({ skipped: 1, failed: 0, costMicroUsd: 0 });
  });

  it('charges a failed attempt, or one with no reported usage, at least its bound', async () => {
    const bound = (text: string) => attemptBoundMicroUsd(text, NOW());
    const one = [items[1]!];
    const failed = await makeAudio([{ name: 'voiceNotes', items: one }], { speak: async () => ({ spoken: null, usage: null }) }, io(), NOW);
    expect(failed).toMatchObject({ failed: 1, costMicroUsd: 2 * bound(one[0]!.text) });
    const partial = await makeAudio([{ name: 'voiceNotes', items: one }], { speak: async (text) => ({ ...spoken(text, 10), spoken: null }) }, io(), NOW);
    expect(partial.costMicroUsd).toBe(2 * bound(one[0]!.text));
    const unreported = await makeAudio([{ name: 'voiceNotes', items: one }], { speak: async (text) => ({ ...spoken(text), usage: null }) }, io(), NOW);
    expect(unreported).toMatchObject({ kept: 1, costMicroUsd: bound(one[0]!.text) });
  });

  it('reserves its bound before every attempt, retries included, and never passes $1', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...items[1]!, id: `vn-${i}`, file: `voice-notes/vn-${i}.wav` }));
    const bound = attemptBoundMicroUsd(many[0]!.text, NOW());
    let calls = 0;
    const capped: Speaker = { speak: async () => (calls++, { spoken: null, usage: null }) };
    const counts = await makeAudio([{ name: 'voiceNotes', items: many }], capped, io(), NOW);
    expect(counts.stopped).toBe(true);
    expect(counts.costMicroUsd).toBeLessThanOrEqual(MAX_MICRO_USD);
    expect(counts.costMicroUsd + bound).toBeGreaterThan(MAX_MICRO_USD);
    expect(calls).toBe(Math.floor(MAX_MICRO_USD / bound));
  });
});

describe('Live speech usage', () => {
  it('reads the Live response fields, so generated audio is charged', () => {
    const meta = {
      promptTokenCount: 30,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 30 }],
      responseTokenCount: 120,
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
    } as unknown as Parameters<typeof liveUsage>[0];
    expect(liveUsage(meta)).toEqual({ input: { text: 30 }, output: { audio: 100, unknown: 20 } });
    for (const empty of [{}, { promptTokenCount: 30 }, { promptTokenCount: 30, responseTokenCount: 0 }]) {
      expect(liveUsage(empty as Parameters<typeof liveUsage>[0]), JSON.stringify(empty)).toBeNull();
    }
  });
});

describe('meter photos', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xda, 0, 2, 1, 2, 0xff, 0xd9]);
  const chunk = (type: string, data: number[] = []) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return [...head, ...data, 0, 0, 0, 0];
  };
  const png = (...chunks: number[][]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunks.flat()]);

  it('takes a plain PNG and refuses metadata, other formats (JPEG included) and oversize files', () => {
    expect(photoProblem(jpeg)).toMatch(/not a PNG/);
    expect(photoProblem(png(chunk('IHDR', [0, 0, 0, 1]), chunk('IDAT', [1]), chunk('IEND')))).toBeNull();
    expect(photoProblem(png(chunk('IHDR'), chunk('tEXt', [65]), chunk('IEND')))).toMatch(/metadata/);
    expect(photoProblem(png(chunk('IHDR'), chunk('eXIf', [65]), chunk('IEND')))).toMatch(/metadata/);
    expect(photoProblem(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toMatch(/not a PNG/);
    expect(photoProblem(new Uint8Array(4 * 1024 * 1024 + 1))).toMatch(/4 MB/);
    expect(photoProblem(new Uint8Array(0))).toMatch(/4 MB/);
  });

  const chunks = (bytes: Uint8Array) => {
    const types: string[] = [];
    for (let at = 8; at + 8 <= bytes.byteLength; ) {
      const length = Buffer.from(bytes.subarray(at, at + 4)).readUInt32BE(0);
      types.push(Buffer.from(bytes.subarray(at + 4, at + 8)).toString('ascii'));
      at += 12 + length;
    }
    return types;
  };

  it('writes a plain RGB PNG: header, image data and end only, so no metadata', () => {
    const bytes = pngFile({ width: 2, height: 1, rgb: new Uint8Array([255, 0, 0, 0, 0, 255]) });
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(chunks(bytes)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(photoProblem(bytes)).toBeNull();
  });

  // One shared render of the 60 photos serves both tests below; the determinism test draws a second, fresh one to compare.
  const photos = loadDataset('meterPhotos');
  let rendered: ReturnType<typeof renderAll> | undefined;
  const renderedOnce = () => (rendered ??= renderAll(photos));

  it('draws the same bytes every time, and a different image for each shot', () => {
    const twice = [renderedOnce(), renderAll(photos)];
    expect(twice[0]!.map((p) => p.sha256)).toEqual(twice[1]!.map((p) => p.sha256));
    expect(new Set(twice[0]!.map((p) => p.sha256)).size).toBe(60);
    const readable = photos.find((p) => p.readable)!;
    const blank = photos.find((p) => p.shot === 'display is blank')!;
    expect(sha256(pngFile(renderMeterPhoto({ ...readable, value: '12.3' }, 0)))).not.toBe(sha256(pngFile(renderMeterPhoto(readable, 0))));
    expect(() => renderMeterPhoto({ ...blank, shot: 'a shot nobody listed' }, 0)).toThrow(/no drawing/);
  }, 30_000);

  it('commits all 60 photos: each file is the drawing of its row, pinned by its SHA-256, under 4 MB', () => {
    for (const photo of renderedOnce()) {
      const row = photos.find((p) => p.id === photo.id)!;
      expect(row).toMatchObject({ file: photo.file, sha256: photo.sha256 });
      const committed = readFileSync(`${DATA_DIR}${row.file}`);
      expect(sha256(committed), row.id).toBe(row.sha256);
      expect(photoProblem(committed)).toBeNull();
    }
  }, 30_000);
});
