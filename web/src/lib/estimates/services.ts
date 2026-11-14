import { serverDatabase } from '@/lib/auth/services';
import { estimatesService, type EstimatesService } from './service';

let service: EstimatesService | null = null;

// Built on the first request over the server's database, then reused.
export function estimatesServices(): EstimatesService {
  service ??= estimatesService(serverDatabase());
  return service;
}
