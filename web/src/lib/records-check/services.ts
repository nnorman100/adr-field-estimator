import { serverDatabase } from '@/lib/auth/services';
import { parseProjectionConfig } from '@/lib/config';
import { evidenceBucket } from '@/lib/photos/services';
import { firestoreFor } from '@/lib/projection/firestore';
import { recordsCheckService, type RecordsCheckService } from './service';
import { bucketEvidenceObjects, firestoreDraftMarks } from './stores';

let service: RecordsCheckService | null = null;

// Built on the first records check from the checked server configuration (the field database the
// drafts are in and the evidence bucket the photo routes write), then reused. A missing setting
// throws and that request fails closed.
export function recordsCheckServices(): RecordsCheckService {
  if (!service) {
    const field = parseProjectionConfig(process.env);
    service = recordsCheckService(
      serverDatabase(),
      firestoreDraftMarks(firestoreFor(field)),
      bucketEvidenceObjects(evidenceBucket()),
    );
  }
  return service;
}
