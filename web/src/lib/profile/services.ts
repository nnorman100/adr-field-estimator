import { serverDatabase } from '@/lib/auth/services';
import { parseLocalSignInFixture } from '@/lib/config';
import { localProfileService } from './local-profile';
import { profileService, type ProfileService } from './service';

let service: ProfileService | null = null;

// Built on the first profile request from the checked server configuration, then reused. A missing
// or invalid setting throws, and that request fails closed. On a developer machine beside the Auth
// emulator, LOCAL_SIGN_IN_FIXTURE stands in for the database (src/lib/profile/local-profile.ts);
// the configuration refuses it anywhere else.
export function profileServices(): ProfileService {
  if (!service) {
    const fixture = parseLocalSignInFixture(process.env);
    service = fixture ? localProfileService(fixture) : profileService(serverDatabase());
  }
  return service;
}
