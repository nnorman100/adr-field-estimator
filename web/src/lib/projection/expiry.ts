import type { Identity } from '@/lib/auth/identity';
import * as services from './services';
import type { AccessReader } from './store';

// When the signed-in member's field database access record stops working (S6-3), read after the
// request path's renewal: the phone opens its sync gate only while this is in the future, because a
// renewal can be skipped (another run holds the actor, or its row waits in back-off) and the
// request still answers 200. Null when there is no record or it cannot be read now; it never fails
// the request. Fixed log text only: no uid, no company id.
export async function fieldAccessExpiry(
  identity: Pick<Identity, 'companyId' | 'uid'>,
  reader?: () => AccessReader,
): Promise<Date | null> {
  try {
    const store = reader ? reader() : services.projectionReader();
    return await store.expiry(identity.companyId, identity.uid);
  } catch (error) {
    console.error('access expiry unavailable', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}
