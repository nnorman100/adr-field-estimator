import { openDatabase } from '@/db/client';
import type { Database } from '@/db/tenant';
import type { Identity } from '@/lib/auth/identity';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreAccessStore, firestoreFor } from './firestore';
import { renewAccess } from './renew';
import type { AccessStore } from './store';

export type ProjectionServices = { db: Database; store: AccessStore };

let services: ProjectionServices | null = null;

// Built from the checked server configuration the first time a record is written, then reused.
export function projectionServices(): ProjectionServices {
  if (!services) {
    const config = parseProjectionConfig(process.env);
    const { db } = openDatabase(process.env);
    services = { db, store: firestoreAccessStore(firestoreFor(config)) };
  }
  return services;
}

// The request path's renewal. It never fails the request: a record it cannot write now is left
// waiting in the outbox for the next run. Fixed log text only.
export async function renewSignedInAccess(
  identity: Pick<Identity, 'companyId' | 'actorId'>,
  build: () => ProjectionServices = projectionServices,
): Promise<void> {
  try {
    const { db, store } = build();
    await renewAccess(db, store, identity);
  } catch (error) {
    console.error('access renewal unavailable', error instanceof Error ? error.name : 'unknown');
  }
}
