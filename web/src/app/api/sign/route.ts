import { linkRoute } from '@/lib/auth';
import { signWithLink, viewSigningLink } from '@/lib/links';

export const dynamic = 'force-dynamic';

// The homeowner's signing link (S5a-11b), by the token in the X-Link-Token header: GET reads the
// documents to sign (or, once signed, the signed record for 30 days); POST signs once, as the
// technician who made the link, through the same transaction as signing on the phone.
export const GET = linkRoute(viewSigningLink);
export const POST = linkRoute(signWithLink);
