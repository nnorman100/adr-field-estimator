import { NextResponse, type NextRequest } from 'next/server';
import { isLinkApiPath, isMemberApiPath, isOperatorApiPath, isPublicApiPath, isServiceApiPath } from '@/lib/public-api';

// Deny by default: an /api route outside the public and member lists refuses a caller with no
// sign-in. A member route (memberRoute in src/lib/auth/route.ts) checks the token, company and job
// access itself, because Proxy is a backstop, not the authorization layer. The release smoke check
// (scripts/smoke-release.ts) relies on this refusal. An internal job route (serviceRoute) checks its
// service token itself in the same way, and a platform operator route (operatorRoute) the operator
// sign-in. A link route (linkRoute) checks the link token it carries.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicApiPath(pathname) || isMemberApiPath(pathname) || isOperatorApiPath(pathname) || isServiceApiPath(pathname) || isLinkApiPath(pathname)) {
    return NextResponse.next();
  }
  return NextResponse.json(
    { error: 'sign_in_required' },
    { status: 401, headers: { 'cache-control': 'no-store', 'www-authenticate': 'Bearer' } },
  );
}

export const config = { matcher: '/api/:path*' };
