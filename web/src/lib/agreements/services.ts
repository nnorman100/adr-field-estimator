import { serverDatabase } from '@/lib/auth/services';
import { agreementsService, type AgreementsService } from './service';

let service: AgreementsService | null = null;

// Built on the first request over the server's database, then reused.
export function agreementsServices(): AgreementsService {
  service ??= agreementsService(serverDatabase());
  return service;
}
