import { z } from 'zod';

// A server-written locator, never an API response or an authoritative job/customer copy.
export const jobProjectionSchema = z.object({
  currentDraftId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  revision: z.number().int().nonnegative().safe(),
}).strict();
export type JobProjection = z.infer<typeof jobProjectionSchema>;
export const jobProjectionPath = (companyId: string, jobId: string) => `companies/${companyId}/jobs/${jobId}`;

