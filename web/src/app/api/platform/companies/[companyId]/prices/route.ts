import { operatorRoute } from '@/lib/auth';
import { supportPrices } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator's read-only support view of a company's prices; each view writes one audit row.
export const GET = operatorRoute(supportPrices);
