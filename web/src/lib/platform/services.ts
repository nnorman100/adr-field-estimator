import { serverDatabase } from '@/lib/auth/services';
import { parseIdentityConfig } from '@/lib/config';
import { projectCommittedChange } from '@/lib/projection/services';
import { noEmailService, platformService, type PlatformService } from './service';
import { firebasePlatformUsers } from './users';

let service: PlatformService | null = null;

// Built on the first operator request from the checked server configuration, then reused. A missing
// or invalid setting throws, and that request fails closed.
export function platformServices(): PlatformService {
  service ??= platformService(
    serverDatabase(),
    firebasePlatformUsers(parseIdentityConfig(process.env)),
    (companyId, actorId) => projectCommittedChange(companyId, actorId),
    noEmailService,
  );
  return service;
}
