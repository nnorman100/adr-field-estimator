import { z } from 'zod';

const features = z.object({ features: z.object({ readiness: z.literal(true) }) });

/** Advisory UI is enabled only by an affirmative flag in the current /api/me response. */
export const readinessEnabled = (body: unknown): boolean => features.safeParse(body).success;
