import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { serverDatabase } from '@/lib/auth/services';
import { parseEvidenceConfig, parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreDraftStates } from './drafts';
import { photosService, type PhotosService } from './service';
import { bucketEvidenceStore } from './store';

let service: PhotosService | null = null;

function storageApp(projectId: string): App {
  const name = `dryscope-evidence-${projectId}`;
  return getApps().find((app) => app.name === name) ?? initializeApp({ projectId }, name);
}

// The evidence bucket from the checked server configuration. The photo routes write it; the records
// check (S8-3) reads it.
export function evidenceBucket() {
  const evidence = parseEvidenceConfig(process.env);
  return getStorage(storageApp(evidence.projectId)).bucket(evidence.bucket);
}

// Built on the first photo request from the checked server configuration (the field database the
// access records use, and the evidence bucket), then reused. A missing setting throws and that
// request fails closed.
export function photosServices(): PhotosService {
  if (!service) {
    const field = parseProjectionConfig(process.env);
    service = photosService(
      serverDatabase(),
      bucketEvidenceStore(evidenceBucket()),
      firestoreDraftStates(firestoreFor(field)),
    );
  }
  return service;
}
