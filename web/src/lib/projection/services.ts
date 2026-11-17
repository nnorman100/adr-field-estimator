import { openDatabase } from '@/db/client';
import type { Database } from '@/db/tenant';
import type { Identity } from '@/lib/auth/identity';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreAccessStore, firestoreFor } from './firestore';
import { projectActor, runAccessProjection, type RunSummary } from './outbox';
import { renewAccess } from './renew';
import type { AccessReader, AccessStore } from './store';

export type ProjectionServices = { db: Database; store: AccessStore };

let services: ProjectionServices | null = null;
let reader: AccessReader | null = null;

// A projection holds its connection until its Firestore write answers, so one slow write must not
// leave other members' renewals waiting for the only connection. Part of each instance's connection
// budget (MAIN_POOL_CONNECTIONS in db/client.ts).
export const PROJECTION_CONNECTIONS = 2;

// Built from the checked server configuration the first time a record is written, then reused.
export function projectionServices(): ProjectionServices {
  if (!services) {
    const config = parseProjectionConfig(process.env);
    const { db } = openDatabase(process.env, { max: PROJECTION_CONNECTIONS });
    const store = firestoreAccessStore(firestoreFor(config));
    services = { db, store };
    reader = store;
  }
  return services;
}

// The same records, read: GET /api/me's expiry (expiry.ts).
export function projectionReader(): AccessReader {
  projectionServices();
  return reader!;
}

// Called by a team change right after its transaction commits, for the member it changed: a
// removal reaches Firestore before the owner's request answers. It never fails that request: a
// record it cannot write now stays waiting in the outbox, for the next run of the outbox pass.
export async function projectCommittedChange(
  companyId: string,
  actorId: string,
  build: () => ProjectionServices = projectionServices,
): Promise<void> {
  try {
    const { db, store } = build();
    await projectActor(db, store, companyId, actorId);
  } catch (error) {
    console.error('access projection unavailable', error instanceof Error ? error.name : 'unknown');
  }
}

// One outbox pass across every company (POST /api/internal/access-projection).
export async function runQueuedProjection(build: () => ProjectionServices = projectionServices): Promise<RunSummary> {
  const { db, store } = build();
  return runAccessProjection(db, store);
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
