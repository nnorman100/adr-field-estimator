import { isQueueTimeout } from '@/db/client';
import { publicRoute } from '@/lib/auth';
import { signInPageFor } from '@/lib/sign-in';
import { signInDirectory } from '@/lib/sign-in/services';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// Public: what a company's sign-in page needs before anyone signs in, its name and its sign-in
// tenant, both of which every visitor's browser receives anyway. Nothing else about the company is
// returned. An unknown, inactive, tenant-less or malformed address answers 404 the same way. A
// missing database configuration or a failed lookup is an error, never a 404; a lookup that found no
// free connection in time answers 503.
export const GET = publicRoute(
  async (_request: Request, context: { params: Promise<Record<string, string | string[] | undefined>> }) => {
  const { address } = await context.params;
  let page;
  try {
    page = await signInPageFor(signInDirectory(), address);
  } catch (error) {
    if (!isQueueTimeout(error)) throw error;
    return Response.json({ error: 'sign_in_unavailable' }, { status: 503, headers: NO_STORE });
  }
  if (!page) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  return Response.json({ company: { name: page.companyName }, tenantId: page.tenantId }, { headers: NO_STORE });
  },
);
