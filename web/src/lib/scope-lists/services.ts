import { serverDatabase } from '@/lib/auth/services';
import { scopeListsService, type ScopeListsService } from './service';

// Built on every call over the server's database (itself a process singleton), so the service never
// holds on to an earlier database handle.
export function scopeListsServices(): ScopeListsService {
  return scopeListsService(serverDatabase());
}
