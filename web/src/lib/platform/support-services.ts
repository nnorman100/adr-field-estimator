import { serverDatabase } from '@/lib/auth/services';
import { evidenceBucket } from '@/lib/photos/services';
import { bucketEvidenceStore } from '@/lib/photos/store';
import { supportJobsService, type SupportJobsService } from './support-jobs';

let service: SupportJobsService | null = null;

// Built on the first support view of a company's jobs from the checked server configuration (the
// database and the evidence bucket the photo routes read), then reused. A missing setting throws and
// that request fails closed.
export function supportJobsServices(): SupportJobsService {
  service ??= supportJobsService(serverDatabase(), bucketEvidenceStore(evidenceBucket()));
  return service;
}
