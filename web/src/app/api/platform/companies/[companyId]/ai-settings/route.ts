import { operatorRoute } from '@/lib/auth';
import { setAiSettings } from '@/lib/ai/http';

export const dynamic = 'force-dynamic';

// The operator sets one company's daily and monthly AI ceilings (S7-4), with one audit row. No
// company role can: an owner, estimator or office user gets 403 here. It needs a sign-in under 15
// minutes old (D7, extended by the owner on 2026-11-14).
export const PUT = operatorRoute(setAiSettings, { freshSignIn: true });
