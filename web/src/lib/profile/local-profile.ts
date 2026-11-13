import { readFixtureSync, updateFixture } from '@/lib/sign-in/local-directory';
import { PROFILE_FIELDS } from './schema';
import { ProfileError, profileOf, type ProfileService } from './service';

// A stand-in for the company profile in Postgres, kept in the same JSON file as the sign-in
// stand-in (LOCAL_SIGN_IN_FIXTURE), so the company settings screen can be driven end to end against
// the Auth emulator with no database (tests/e2e/company.spec.ts). It follows profileService
// (service.ts) rule for rule; only the storage differs, and it writes no audit row. The
// configuration allows it only on a developer machine (src/lib/config.ts).

const EMPTY = { address: '', phone: '', email: '', license: '', signoff: '' };

export function localProfileService(path: string): ProfileService {
  const view = (company: ReturnType<typeof readFixtureSync>['companies'][number]) =>
    profileOf({ id: company.id, name: company.name, ...EMPTY, ...company.profile });

  return {
    async read(companyId) {
      const company = readFixtureSync(path).companies.find((c) => c.id === companyId);
      if (!company) throw new ProfileError('not_found');
      return view(company);
    },
    async save(companyId, _actorId, input) {
      return updateFixture(path, (data) => {
        const company = data.companies.find((c) => c.id === companyId);
        if (!company) throw new ProfileError('not_found');
        const current = { ...EMPTY, ...company.profile };
        if (PROFILE_FIELDS.some((field) => current[field] !== input[field])) company.profile = { ...input };
        return view(company);
      });
    },
  };
}
