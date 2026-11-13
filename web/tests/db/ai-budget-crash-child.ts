// Run by ai-budget.test.ts as a separate process, then killed with SIGKILL while its model call is in
// progress: a real crash after the AI boundary reserved money and before it could settle. The fake
// model writes a marker file, then never returns. Model Armor is not asked: voice notes go to the
// transcription model unscreened (owner decision V1), so the reservation is followed by the model.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { openDatabase } from '@/db/client';
import { postgresAiBudget } from '@/lib/ai/budget';
import { createAiBoundary } from '@/lib/ai/call';

const { CRASH_DATABASE_URL, CRASH_COMPANY, CRASH_ACTOR, CRASH_CALL, CRASH_MARKER } = process.env;
if (!CRASH_DATABASE_URL || !CRASH_COMPANY || !CRASH_ACTOR || !CRASH_CALL || !CRASH_MARKER) process.exit(2);

const hang = () => new Promise<never>(() => {});
const { db } = openDatabase({ APP_ENV: 'test', DATABASE_URL: CRASH_DATABASE_URL });
const budget = postgresAiBudget(db);
const boundary = createAiBoundary({
  model: {
    async generate() {
      writeFileSync(CRASH_MARKER, 'model called');
      return hang();
    },
  },
  armor: {
    async screenPrompt() {
      throw new Error('not asked for a voice note');
    },
    async screenResponse() {
      return hang();
    },
  },
  quota: budget,
  budget,
  log: () => {},
  newCallId: () => CRASH_CALL,
});

await boundary.call(
  { companyId: CRASH_COMPANY, actorId: CRASH_ACTOR, capabilities: ['scope'], flags: { ai_voice_notes: true } },
  { feature: 'voice_note', audio: { bytes: new Uint8Array(30_000), mimeType: 'audio/webm' }, schema: z.string() },
);
