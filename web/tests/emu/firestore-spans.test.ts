import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreDraftStore } from '@/lib/jobs/drafts';
import { firestoreDraftStates } from '@/lib/photos/drafts';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { startTracing, type TracingHandle } from '@/lib/telemetry/start';
import { projectId } from './auth-emulator';

// TC-3: the real Admin SDK calls against the Firestore emulator each make one span named by the
// operation and the collection, and no span holds a company id, a document id or a uid.
const exporter = new InMemorySpanExporter();
let handle: TracingHandle | null;

beforeAll(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  handle = startTracing({ mode: 'spans', appEnv: 'local' }, { exporter, simple: true });
});
afterAll(async () => {
  await handle?.shutdown();
  vi.restoreAllMocks();
});

describe('Firestore spans', () => {
  it('names each call by operation and collection only', async () => {
    const db = firestoreFor(
      parseProjectionConfig({
        APP_ENV: 'local',
        GOOGLE_CLOUD_PROJECT: projectId,
        FIRESTORE_DATABASE_ID: '(default)',
        FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
      }),
    );
    const [company, draft, uid] = [randomUUID(), randomUUID(), `uid-${randomUUID()}`];
    await firestoreDraftStore(db).ensure(company, randomUUID(), draft, uid);
    await firestoreDraftStates(db).state(company, draft);
    const access = firestoreAccessStore(db);
    await access.grant({ companyId: company, authTenantId: 'tenant-x', uid, role: 'estimator', expiresAt: new Date(Date.now() + 1000), version: 1 });
    await access.remove(company, uid, 2);

    const spans = exporter.getFinishedSpans() as ReadableSpan[];
    // The Admin SDK adds spans of its own below ours (Transaction.Run and the like); ours are the
    // ones this app names.
    const ours = spans.filter((s) => s.instrumentationScope.name === 'dryscope-web');
    expect(spans.length).toBeGreaterThan(ours.length);
    expect(ours.map((s) => s.name)).toEqual([
      'firestore.runTransaction drafts',
      'firestore.get drafts',
      'firestore.runTransaction access',
      'firestore.runTransaction access',
      'firestore.get access',
    ]);
    expect(ours[0]!.attributes).toEqual({
      'db.system.name': 'gcp.firestore',
      'db.operation.name': 'runTransaction',
      'db.collection.name': 'drafts',
    });
    // Every span, the SDK's included.
    const everything = JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events]));
    for (const secret of [company, draft, uid, 'tenant-x']) expect(everything).not.toContain(secret);
  });
});
