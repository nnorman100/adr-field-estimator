import { operatorRoute } from '@/lib/auth';
import { recordsCheck } from '@/lib/records-check/http';

export const dynamic = 'force-dynamic';

// The records check after a restore (S8-3): one bounded, read-only page per call of a run that
// compares the company's submissions, field draft marks, evidence registry, bucket objects and
// signatures, answering counts and ids only. It writes one audit row per run and needs a sign-in
// under 15 minutes old.
export const POST = operatorRoute(recordsCheck, { freshSignIn: true });
