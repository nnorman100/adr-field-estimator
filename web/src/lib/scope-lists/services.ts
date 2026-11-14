import { serverDatabase } from '@/lib/auth/services';
import { scopeListsService, type ScopeListsService } from './service';

let service: ScopeListsService | null = null;

// Built on the first request over the server's database, then reused.
export function scopeListsServices(): ScopeListsService {
  service ??= scopeListsService(serverDatabase());
  return service;
}
