import { memberRoute } from '@/lib/auth';
import { getPhoto, putPhoto } from '@/lib/photos';

export const dynamic = 'force-dynamic';

// Reads one photo's bytes, its full-size original with ?kind=original, or a customer's signature
// with ?kind=signature (S5a-11), as the image it is.
export const GET = memberRoute(getPhoto);

// Stores one photo (?kind=photo), its full-size original (?kind=original) or the customer's
// signature (?kind=signature, before signing) from a raw image body and answers the receipt. Sent again with the same bytes it answers the same receipt.
export const PUT = memberRoute(putPhoto);
