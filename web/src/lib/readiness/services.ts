import { serverDatabase } from '@/lib/auth/services';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreReadinessReader } from './reader';
import { readinessService, type ReadinessService } from './service';

// Built on every call over the server's database and field database (each a process singleton), from
// the checked server configuration the job drafts use. A missing setting throws and that request
// answers 503, which the screens treat as no answer.
export function readinessServices(): ReadinessService {
  return readinessService(serverDatabase(), firestoreReadinessReader(firestoreFor(parseProjectionConfig(process.env))));
}
