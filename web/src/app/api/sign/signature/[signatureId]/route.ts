import { linkRoute } from '@/lib/auth';
import { sendLinkSignature } from '@/lib/links';

export const dynamic = 'force-dynamic';

// The homeowner's drawn signature (S5a-11b) under the id their browser made, before signing; the
// same bytes again answer the same receipt.
export const PUT = linkRoute(sendLinkSignature);
