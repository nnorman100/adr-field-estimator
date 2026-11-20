import { serverDatabase } from '@/lib/auth/services';
import { approvalsService, type ApprovalsService } from './service';

let service: ApprovalsService | null = null;

// Built on the first request over the server's database, then reused.
export function approvalsServices(): ApprovalsService {
  service ??= approvalsService(serverDatabase());
  return service;
}
