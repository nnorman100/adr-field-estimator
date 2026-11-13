import { describe, expect, it } from 'vitest';
import type { Speaker, Spoken } from '@/lib/ai/eval-speech';
import { addPhotos, parsePhotoArgs } from '../../scripts/add-eval-photos';
import { AudioArgsError, checkAudioEnv, makeAudio, MAX_MICRO_USD, VOICES } from '../../scripts/make-eval-audio';
import { DATA_DIR } from '../ai-evals/datasets';
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

  const spoken = (text: string, outputTokens = 100): Spoken => ({
    pcm24k: pcm([0, 100, 200, 300, 400, 500]),
    transcript: text,
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
  const items = [
    { id: 'vn-01', text: 'The subfloor reads twenty eight percent.', file: 'voice-notes/vn-01.wav', sha256: null },
    { id: 'vn-02', text: 'Drywall is wet behind the vanity.', file: 'voice-notes/vn-02.wav', sha256: null },
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

  it('skips files already there with their hash, and stops before passing $1', async () => {
    const files = io();
    const wav = wavFile(pcm([1]));
    files.files.set(`${DATA_DIR}voice-notes/vn-01.wav`, wav);
    const skipped = await makeAudio([{ name: 'voiceNotes', items: [{ ...items[0]!, sha256: sha256(wav) }] }], { speak: async () => null }, files);
    expect(skipped).toMatchObject({ skipped: 1, failed: 0 });
    // 100,000 audio tokens at $12 a million is $1.20: the first clip spends past $1, the second never starts.
    const expensive = await makeAudio([{ name: 'voiceNotes', items }], { speak: async (text) => spoken(text, 100_000) }, io());
    expect(expensive.costMicroUsd).toBeGreaterThan(MAX_MICRO_USD);
    expect(expensive).toMatchObject({ kept: 1, stopped: true });
  });
});

describe('meter photos', () => {
  const jpeg = (segments: number[][]) => new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0, 2, 1, 2, 0xff, 0xd9]);
  const app0 = [0xff, 0xe0, 0, 4, 0x4a, 0x46];
  const exif = [0xff, 0xe1, 0, 4, 0x45, 0x78];
  const chunk = (type: string, data: number[] = []) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return [...head, ...data, 0, 0, 0, 0];
  };
  const png = (...chunks: number[][]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunks.flat()]);

  it('takes a plain JPEG or PNG and refuses metadata, other formats and oversize files', () => {
    expect(photoProblem(jpeg([app0]))).toBeNull();
    expect(photoProblem(jpeg([app0, exif]))).toMatch(/Exif/);
    expect(photoProblem(png(chunk('IHDR', [0, 0, 0, 1]), chunk('IDAT', [1]), chunk('IEND')))).toBeNull();
    expect(photoProblem(png(chunk('IHDR'), chunk('tEXt', [65]), chunk('IEND')))).toMatch(/metadata/);
    expect(photoProblem(png(chunk('IHDR'), chunk('eXIf', [65]), chunk('IEND')))).toMatch(/metadata/);
    expect(photoProblem(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toMatch(/JPEG or PNG/);
    expect(photoProblem(new Uint8Array(4 * 1024 * 1024 + 1))).toMatch(/4 MB/);
    expect(photoProblem(new Uint8Array(0))).toMatch(/4 MB/);
  });

  it('adds the good photos by id, writing the bytes it checked, and counts the rest', () => {
    const disk = new Map<string, Uint8Array>([
      ['/in/mp-01.jpg', jpeg([app0])],
      ['/in/mp-02.png', png(chunk('IHDR'), chunk('IEND'))],
      ['/in/mp-03.jpg', jpeg([exif])],
    ]);
    const written = new Map<string, Uint8Array>();
    const { counts, changes } = addPhotos('/in', { read: (p) => disk.get(p) ?? null, write: (p, b) => void written.set(p, b) });
    expect(counts).toEqual({ added: 2, missing: 57, refused: { 'has an Exif or XMP block (strip metadata first)': 1 } });
    expect(changes.get('mp-02')).toEqual({ file: 'meter-photos/mp-02.png', sha256: sha256(disk.get('/in/mp-02.png')!) });
    expect([...written.keys()]).toEqual([`${DATA_DIR}meter-photos/mp-01.jpg`, `${DATA_DIR}meter-photos/mp-02.png`]);
    expect(() => parsePhotoArgs([])).toThrow(/usage/);
  });
});
