import { beforeEach, describe, expect, it, vi } from 'vitest';

// The AI call line goes out through the shared logger (src/lib/log.ts), not a writer of its own.
const shared = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('@/lib/log', () => ({ log: shared.log }));

import { aiLog, type AiLogLine } from '@/lib/ai/telemetry';

const VERSION = 'b'.repeat(64);

describe('aiLog', () => {
  beforeEach(() => shared.log.mockClear());

  it('emits one INFO ai_call line through the shared logger, with only the checked fields', () => {
    aiLog({
      feature: 'summary_draft',
      model: 'gemini-3.8-flash',
      promptVersion: VERSION,
      inputTokens: 1,
      outputTokens: 2,
      latencyMs: 3,
      outcome: 'ok',
      verdict: 'passed',
    });
    expect(shared.log).toHaveBeenCalledTimes(1);
    expect(shared.log).toHaveBeenCalledWith('INFO', 'ai_call', {
      component: 'ai',
      feature: 'summary_draft',
      model: 'gemini-3.8-flash',
      promptVersion: VERSION,
      inputTokens: 1,
      outputTokens: 2,
      latencyMs: 3,
      outcome: 'ok',
      verdict: 'passed',
    });
  });

  it('logs a refusal at WARNING and turns text in a field into the word invalid', () => {
    aiLog({
      feature: 'jane@example.com',
      model: '12 Oak St',
      promptVersion: 'x',
      outcome: 'model_busy',
    } as unknown as AiLogLine);
    const [severity, , fields] = shared.log.mock.calls[0]!;
    expect(severity).toBe('WARNING');
    expect(fields).toMatchObject({
      feature: 'invalid',
      model: 'invalid',
      promptVersion: 'invalid',
      outcome: 'model_busy',
    });
    expect(JSON.stringify(fields)).not.toMatch(/example\.com|Oak/);
  });
});
