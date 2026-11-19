import { serverDatabase } from '@/lib/auth/services';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreFenceStore } from '@/lib/submissions/fence';
import { archiveService, type ArchiveService } from './archive';
import { firestoreArchiveStore } from './archive-store';
import { firestoreDraftStore } from './drafts';
import { officeService, type OfficeService } from './office';
import { jobsService, type JobsService } from './service';

// Every jobs route's service: the jobs themselves (S5a-3), the office's coordination, assignment
// and field owner (S5b-1), and archive, restore and copy (S5b-2), over one database and one field
// database.
export type JobRoutesService = JobsService & OfficeService & ArchiveService;

let service: JobRoutesService | null = null;

// Built on the first jobs request from the checked server configuration (the same project and field
// database the access records use), then reused. A missing setting throws and that request fails
// closed.
export function jobsServices(): JobRoutesService {
  if (!service) {
    const config = parseProjectionConfig(process.env);
    const db = serverDatabase();
    const firestore = firestoreFor(config);
    const drafts = firestoreDraftStore(firestore);
    service = { ...jobsService(db, drafts), ...officeService(db, drafts, firestoreFenceStore(firestore)), ...archiveService(db, firestoreArchiveStore(firestore)) };
  }
  return service;
}
