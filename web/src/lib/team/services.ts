import { serverDatabase } from '@/lib/auth/services';
import { parseIdentityConfig, parseLocalSignInFixture } from '@/lib/config';
import { projectCommittedChange } from '@/lib/projection/services';
import { localTeamService } from './local-team';
import { teamService, type TeamService } from './service';
import { firebaseTenantUsers } from './users';

let service: TeamService | null = null;

// Built on the first team request from the checked server configuration, then reused. A missing or
// invalid setting throws, and that request fails closed. On a developer machine beside the Auth
// emulator, LOCAL_SIGN_IN_FIXTURE stands in for the database (src/lib/team/local-team.ts); the
// configuration refuses it anywhere else.
export function teamServices(): TeamService {
  if (!service) {
    const config = parseIdentityConfig(process.env);
    const fixture = parseLocalSignInFixture(process.env);
    service = fixture
      ? localTeamService(fixture, firebaseTenantUsers(config))
      : teamService(serverDatabase(), firebaseTenantUsers(config), (companyId, actorId) =>
          projectCommittedChange(companyId, actorId),
        );
  }
  return service;
}
