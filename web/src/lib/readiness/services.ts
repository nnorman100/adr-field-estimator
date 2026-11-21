import { serverDatabase } from '@/lib/auth/services';
import { parseProjectionConfig } from '@/lib/config';
import { dryingSetupReadings } from '@/lib/drying/setup';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreReadinessReader } from './reader';
import { readinessService, type ReadinessService } from './service';

// Built on every call over the server's database; the field database (a process singleton) is built from
// the checked server configuration the job drafts use only when the service first reads a draft, after
// Postgres has decided who may read the job. A missing setting then answers `field_unavailable`. The
// setup reading is the drying log's (S5b-10, src/lib/drying/setup.ts).
export function readinessServices(): ReadinessService {
  return readinessService(serverDatabase(), () => firestoreReadinessReader(firestoreFor(parseProjectionConfig(process.env))), dryingSetupReadings);
}
