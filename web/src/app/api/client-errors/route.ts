import { publicRoute } from '@/lib/auth';
import { handleClientErrors } from '@/lib/client-error-intake';

// Browser and phone error reports (TC-2). Public and write-only: see src/lib/client-error-intake.ts
// for the limits and what is written. It reads no company data, so it has no role-matrix key.
export const POST = publicRoute(handleClientErrors);
