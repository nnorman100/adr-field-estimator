import { serverDatabase } from '@/lib/auth/services';
import { parseIdentityConfig } from '@/lib/config';
import { teamService, type TeamService } from './service';
import { firebaseTenantUsers } from './users';

let service: TeamService | null = null;

// Built on the first team request from the checked server configuration, then reused. A missing or
// invalid setting throws, and that request fails closed.
export function teamServices(): TeamService {
  service ??= teamService(serverDatabase(), firebaseTenantUsers(parseIdentityConfig(process.env)));
  return service;
}
