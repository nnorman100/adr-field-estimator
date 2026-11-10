import { NextResponse, type NextRequest } from 'next/server';
import { isMemberApiPath, isPublicApiPath } from '@/lib/public-api';

// Deny by default: an /api route outside the public and member lists refuses a caller with no
// sign-in. A member route (memberRoute in src/lib/auth/route.ts) checks the token, company and job
// access itself, because Proxy is a backstop, not the authorization layer. The release smoke check
// (scripts/smoke-release.ts) relies on this refusal.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicApiPath(pathname) || isMemberApiPath(pathname)) return NextResponse.next();
  return NextResponse.json(
    { error: 'sign_in_required' },
    { status: 401, headers: { 'cache-control': 'no-store', 'www-authenticate': 'Bearer' } },
  );
}

export const config = { matcher: '/api/:path*' };
