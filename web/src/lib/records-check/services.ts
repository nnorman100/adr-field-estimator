import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { serverDatabase } from '@/lib/auth/services';
import { parseEvidenceConfig, parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { recordsCheckService, type RecordsCheckService } from './service';
import { bucketEvidenceObjects, firestoreDraftMarks } from './stores';

let service: RecordsCheckService | null = null;

function storageApp(projectId: string): App {
  const name = `dryscope-evidence-${projectId}`;
  return getApps().find((app) => app.name === name) ?? initializeApp({ projectId }, name);
}

// Built on the first records check from the checked server configuration (the field database the
// drafts are in and the evidence bucket the photo routes write), then reused. A missing setting
// throws and that request fails closed.
export function recordsCheckServices(): RecordsCheckService {
  if (!service) {
    const evidence = parseEvidenceConfig(process.env);
    const field = parseProjectionConfig(process.env);
    service = recordsCheckService(
      serverDatabase(),
      firestoreDraftMarks(firestoreFor(field)),
      bucketEvidenceObjects(getStorage(storageApp(evidence.projectId)).bucket(evidence.bucket)),
    );
  }
  return service;
}
