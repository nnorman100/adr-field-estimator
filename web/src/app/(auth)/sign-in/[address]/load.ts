import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { parseBrowserSignInConfig } from '@/lib/config';
import { SIGN_IN_PAGE_HEADER, signInPageOf } from '@/lib/sign-in/page-request';
import type { SignInScreenProps } from './sign-in-screen';

// What a company sign-in page renders with, read on the server for every request. An unknown,
// inactive or malformed address shows "This sign-in link is not recognised" (not-found.tsx) with a
// 404, the same for each, so the page says nothing about which addresses exist beyond the public
// name and tenant of a company that is signing people in. Proxy looked the address up before the
// page renders (lib/sign-in/page-request.ts), and answered 503 itself when no database connection
// came free in time.
export async function loadSignInScreen(address: string, invitationId: string | null = null): Promise<SignInScreenProps> {
  const page = signInPageOf((await headers()).get(SIGN_IN_PAGE_HEADER));
  if (!page) notFound();
  return {
    address,
    companyName: page.companyName,
    tenantId: page.tenantId,
    invitationId,
    config: parseBrowserSignInConfig(process.env),
  };
}
