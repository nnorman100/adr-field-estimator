import { memberRoute } from '@/lib/auth';
import { readProfile, saveProfile } from '@/lib/profile';

export const dynamic = 'force-dynamic';

// The company profile the four documents print. Only the owner (profile_manage) reads or changes
// it; an estimator or office user is refused, and another company's owner is told it does not exist.
export const GET = memberRoute(readProfile);
export const PUT = memberRoute(saveProfile);
