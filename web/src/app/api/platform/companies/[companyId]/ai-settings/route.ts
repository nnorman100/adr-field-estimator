import { operatorRoute } from '@/lib/auth';
import { setAiSettings } from '@/lib/ai/http';

export const dynamic = 'force-dynamic';

// The operator sets one company's daily and monthly AI ceilings (S7-4), with one audit row. No
// company role can: an owner, estimator or office user gets 403 here.
export const PUT = operatorRoute(setAiSettings);
