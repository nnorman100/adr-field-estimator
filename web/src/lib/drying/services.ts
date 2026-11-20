import { serverDatabase } from '@/lib/auth/services';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreReadinessReader } from '@/lib/readiness/reader';
import { readingsService, type ReadingsService } from './readings';
import { accuracyService, type AccuracyService } from './accuracy-service';
import { outcomeService, type OutcomeService } from './outcome';
import { watchService, type WatchService } from './watch-service';

// Built on every call over the server's database. The field database (a process singleton) is built
// from the checked server configuration only when a room reading of a job being edited needs its
// draft's rooms, after Postgres has decided who may write the job; a missing setting then fails that
// request closed.
export function dryingServices(): { readings: ReadingsService; watch: WatchService; outcome: OutcomeService; accuracy: AccuracyService } {
  const db = serverDatabase();
  return { readings: readingsService(db, () => firestoreReadinessReader(firestoreFor(parseProjectionConfig(process.env)))), watch: watchService(db), outcome: outcomeService(db), accuracy: accuracyService(db) };
}
