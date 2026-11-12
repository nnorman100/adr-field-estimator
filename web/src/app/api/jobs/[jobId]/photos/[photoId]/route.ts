import { memberRoute } from '@/lib/auth';
import { getPhoto, putPhoto } from '@/lib/photos';

export const dynamic = 'force-dynamic';

// Reads one photo's bytes, or its full-size original with ?kind=original, as the image it is.
export const GET = memberRoute(getPhoto);

// Stores one photo (?kind=photo) or its full-size original (?kind=original) from a raw image body
// and answers the receipt. Sent again with the same bytes it answers the same receipt.
export const PUT = memberRoute(putPhoto);
