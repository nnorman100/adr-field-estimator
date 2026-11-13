import { serverDatabase } from '@/lib/auth/services';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreFenceStore } from './fence';
import { runSubmissionRepair, type RepairSummary } from './repair';
import { submissionsService, type SubmissionsService } from './service';

let service: SubmissionsService | null = null;

// Built on the first request from the checked server configuration (the same project and field
// database the access records and the job drafts use), then reused. A missing setting throws and
// that request fails closed.
export function submissionsServices(): SubmissionsService {
  if (!service) {
    const config = parseProjectionConfig(process.env);
    service = submissionsService(serverDatabase(), firestoreFenceStore(firestoreFor(config)));
  }
  return service;
}

// The worker's Submit pass (POST /api/internal/access-projection, beside the access outbox).
export async function runQueuedSubmissionRepair(): Promise<RepairSummary> {
  const config = parseProjectionConfig(process.env);
  return runSubmissionRepair(serverDatabase(), firestoreFenceStore(firestoreFor(config)));
}
