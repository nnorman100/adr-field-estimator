import { NextResponse, type NextRequest } from 'next/server';
import { isQueueTimeout } from '@/db/client';
import { signInPageFor, type SignInPage } from './directory';
import { signInDirectory } from './services';

// A company sign-in page and every screen under its address (/sign-in/{address}/...) is looked up
// here, in Proxy, before the page renders, because a page cannot answer 503 itself: a lookup that
// found no free database connection in time (security audit F5) answers a plain 503 from the
// requested address. Otherwise the page found, if any, goes on to the page in a request header
// that Proxy always sets or removes itself (load.ts reads it), so the address is looked up once.
export const SIGN_IN_PAGE_HEADER = 'x-dryscope-sign-in-page';

const PAGE_PATH = /^\/sign-in\/([^/]+)(?:\/|$)/;

export function signInPageAddress(pathname: string): string | null {
  return PAGE_PATH.exec(pathname)?.[1] ?? null;
}

export async function signInPageRequest(request: NextRequest, address: string): Promise<NextResponse> {
  let page: SignInPage | null;
  try {
    page = await signInPageFor(signInDirectory(), address);
  } catch (error) {
    if (!isQueueTimeout(error)) throw error;
    return new NextResponse('DryScope is busy. Try again shortly.\n', {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '10' },
    });
  }
  const headers = new Headers(request.headers);
  headers.delete(SIGN_IN_PAGE_HEADER);
  if (page) headers.set(SIGN_IN_PAGE_HEADER, encodeURIComponent(JSON.stringify(page)));
  return NextResponse.next({ request: { headers } });
}

// The page Proxy found for this request, or null when it found none.
export function signInPageOf(value: string | null): SignInPage | null {
  if (value === null) return null;
  const page = JSON.parse(decodeURIComponent(value)) as Partial<SignInPage>;
  if (typeof page.companyName !== 'string' || typeof page.tenantId !== 'string') return null;
  return { companyName: page.companyName, tenantId: page.tenantId };
}
