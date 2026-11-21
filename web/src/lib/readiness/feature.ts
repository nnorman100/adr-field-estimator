import { z } from 'zod';

const features = z.object({ features: z.object({ readiness: z.literal(true) }) });

/** Advisory UI is enabled only by an affirmative flag in the current /api/me response. */
export const readinessEnabled = (body: unknown): boolean => features.safeParse(body).success;

const aiSummary = z.object({ features: z.object({ ai_summary: z.literal(true) }) });

/** "Draft with AI" on Check Scope (S7-6) shows only on an affirmative switch in the current /api/me answer. */
export const aiSummaryEnabled = (body: unknown): boolean => aiSummary.safeParse(body).success;
