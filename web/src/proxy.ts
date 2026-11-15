import { NextResponse, type NextRequest } from 'next/server';
import {
  isMemberApiPath,
  isOperatorApiPath,
  isPublicApiPath,
  isServiceApiPath,
} from '@/lib/public-api';
import { addCspReportOnly } from '@/lib/csp';

// Deny by default: an /api route outside the public and member lists refuses a caller with no
// sign-in. A member route (memberRoute in src/lib/auth/route.ts) checks the token, company and job
// access itself, because Proxy is a backstop, not the authorization layer. The release smoke check
// (scripts/smoke-release.ts) relies on this refusal. An internal job route (serviceRoute) checks its
// service token itself in the same way, and a platform operator route (operatorRoute) the operator
// sign-in.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const api = pathname === '/api' || pathname.startsWith('/api/');
  const allowed =
    !api ||
    isPublicApiPath(pathname) ||
    isMemberApiPath(pathname) ||
    isOperatorApiPath(pathname) ||
    isServiceApiPath(pathname);
  const response = allowed
    ? NextResponse.next()
    : NextResponse.json(
        { error: 'sign_in_required' },
        { status: 401, headers: { 'cache-control': 'no-store', 'www-authenticate': 'Bearer' } },
      );
  addCspReportOnly(response, pathname);
  return response;
}

// Pages and the offline shell need the runtime auth domain in their report-only policy too.
export const config = { matcher: '/:path*' };
