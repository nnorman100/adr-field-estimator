import { serverDatabase } from '@/lib/auth/services';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreDraftStore } from './drafts';
import { jobsService, type JobsService } from './service';

let service: JobsService | null = null;

// Built on the first jobs request from the checked server configuration (the same project and field
// database the access records use), then reused. A missing setting throws and that request fails
// closed.
export function jobsServices(): JobsService {
  if (!service) {
    const config = parseProjectionConfig(process.env);
    service = jobsService(serverDatabase(), firestoreDraftStore(firestoreFor(config)));
  }
  return service;
}
