import type { JobStatus } from '@/db/schema';

// A job's status in words, for the field screens and the platform operator's support view alike.
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  draft: 'In progress',
  submitted: 'Submitted',
  signed: 'Signed',
  archived: 'Archived',
};
