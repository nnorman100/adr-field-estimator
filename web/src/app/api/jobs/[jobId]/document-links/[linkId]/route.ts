import { requireFlag } from '@/lib/auth';
import { revokeDocumentLink } from '@/lib/links';

export const dynamic = 'force-dynamic';

// Revokes one document link of the job (S5a-11b): the owner or office (`delivery_resend`).
export const DELETE = requireFlag('price_books', revokeDocumentLink);
