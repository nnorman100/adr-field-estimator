import { NextResponse, type NextRequest } from 'next/server';
import { isPublicApiPath } from '@/lib/public-api';

// Deny by default: an /api route outside the public list refuses a caller with no sign-in. Sign-in
// arrives with identity and isolation (stage S3), which replaces this refusal with token checks; each
// business route must still check identity, company and job access itself, because Proxy is a
// backstop, not the authorization layer. The release smoke check (scripts/smoke-release.ts) relies
// on this refusal.
export function proxy(request: NextRequest) {
  if (isPublicApiPath(request.nextUrl.pathname)) return NextResponse.next();
  return NextResponse.json(
    { error: 'sign_in_required' },
    { status: 401, headers: { 'cache-control': 'no-store', 'www-authenticate': 'Bearer' } },
  );
}

export const config = { matcher: '/api/:path*' };
