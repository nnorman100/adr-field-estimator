import { operatorRoute } from '@/lib/auth';
import { supportTeam } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator's read-only support view of a company's team; each view writes one audit row.
export const GET = operatorRoute(supportTeam);
