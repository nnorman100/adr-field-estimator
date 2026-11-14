import { memberRoute } from '@/lib/auth';
import { readAiUsage } from '@/lib/ai/http';

export const dynamic = 'force-dynamic';

// The company's AI use today and this month against its ceilings (S7-4). Only the owner
// (ai_usage_read) reads it; an estimator or office user is refused, and another company's owner is
// told it does not exist.
export const GET = memberRoute(readAiUsage);
