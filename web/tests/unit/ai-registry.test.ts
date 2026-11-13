import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@/lib/access';
import { AI_PRICES } from '@/lib/ai/pricing';
import { AI_FEATURES, AI_FLAG_NAMES, AI_REGISTRY, definePrompt, promptVersion } from '@/lib/ai/registry';

// The AI registry (S7-1): per feature, the model, endpoint, prompt version (SHA-256 of the prompt
// text), output cap, deadline, per-user daily quota (the old DAILY_LIMITS in
// backend/inspection_store.py, with Live at 20 a day, V5), flag, capability and eval suite.

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('registry', () => {
  it('lists the six S7 features, each with its own flag', () => {
    expect([...AI_FEATURES].sort()).toEqual(
      ['job_summary', 'live', 'meter_reading', 'scope_fill', 'summary_draft', 'voice_note'].sort(),
    );
    expect([...AI_FLAG_NAMES].sort()).toEqual(
      ['ai_job_summary', 'ai_meter_reading', 'ai_scope_fill', 'ai_summary', 'ai_voice_notes', 'live_voice'].sort(),
    );
    const flags = AI_FEATURES.map((feature) => AI_REGISTRY[feature].flag);
    expect(new Set(flags).size).toBe(AI_FEATURES.length);
  });

  it('ports the old per-user daily limits, with Live at 20 sessions (V5)', () => {
    const quota = Object.fromEntries(AI_FEATURES.map((f) => [f, AI_REGISTRY[f].dailyQuotaPerUser]));
    expect(quota).toEqual({
      summary_draft: 60, // audit
      scope_fill: 120, // scope
      meter_reading: 400, // ocr
      voice_note: 200, // transcribe
      job_summary: 60, // job_summary
      live: 20,
    });
  });

  it('keeps text on the us multi-region and Live on us-central1 (V4)', () => {
    for (const feature of AI_FEATURES) {
      const entry = AI_REGISTRY[feature];
      expect(entry.endpoint).toBe(feature === 'live' ? 'live' : 'text');
    }
    expect(AI_REGISTRY.live.model).toBe('gemini-3.8-live');
    expect(AI_REGISTRY.voice_note.model).toBe('gemini-3.5-transcribe');
    for (const feature of ['summary_draft', 'scope_fill', 'meter_reading', 'job_summary'] as const) {
      expect(AI_REGISTRY[feature].model).toBe('gemini-3.8-flash');
    }
  });

  it('gives every feature a known capability, a priced model, a cap, a deadline and an eval suite', () => {
    for (const feature of AI_FEATURES) {
      const entry = AI_REGISTRY[feature];
      expect(CAPABILITIES).toContain(entry.capability);
      expect(AI_PRICES[entry.model]).toBeDefined();
      expect(entry.deadlineMs).toBeGreaterThan(0);
      expect(entry.evalSuite).toMatch(/^[a-z_]+$/);
      if (entry.kind === 'rest') expect(entry.outputTokenCap).toBeGreaterThan(0);
    }
  });

  it('screens audio input only for transcription, which takes no instructions (R2, V1)', () => {
    for (const feature of AI_FEATURES) {
      const screen = AI_REGISTRY[feature].inputScreen;
      if (feature === 'voice_note') expect(screen).toBe('audio_unscreened');
      else expect(screen).not.toBe('audio_unscreened');
    }
    expect(AI_REGISTRY.meter_reading.inputScreen).toBe('image');
  });

  it('carries a prompt version equal to the SHA-256 of each prompt text', () => {
    for (const feature of AI_FEATURES) {
      const prompt = AI_REGISTRY[feature].prompt;
      if (prompt) expect(prompt.version).toBe(sha256(prompt.text));
    }
  });
});

describe('prompt version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-prompt-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function versionOfFile(name: string, text: string): Promise<string> {
    const file = join(dir, name);
    writeFileSync(file, `export default ${JSON.stringify(text)};\n`);
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { default: string };
    return definePrompt(mod.default).version;
  }

  it('changes when a prompt file changes, and only then', async () => {
    const first = await versionOfFile('a.ts', 'Summarise the saved inspection.');
    const same = await versionOfFile('b.ts', 'Summarise the saved inspection.');
    const edited = await versionOfFile('c.ts', 'Summarise the saved inspection!');
    expect(first).toBe(same);
    expect(edited).not.toBe(first);
    expect(first).toBe(sha256('Summarise the saved inspection.'));
  });

  it('is a 64-character hex SHA-256 and refuses an empty prompt', () => {
    expect(promptVersion('x')).toMatch(/^[0-9a-f]{64}$/);
    expect(() => definePrompt('')).toThrow();
    expect(() => definePrompt('   ')).toThrow();
  });
});
