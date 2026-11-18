import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { isQueueTimeout } from '@/db/client';
import { parseBrowserSignInConfig } from '@/lib/config';
import { signInPageFor } from '@/lib/sign-in';
import { signInDirectory } from '@/lib/sign-in/services';
import type { SignInScreenProps } from './sign-in-screen';

// What a company sign-in page renders with, read on the server for every request. An unknown,
// inactive or malformed address shows "This sign-in link is not recognised" (not-found.tsx) with a
// 404, the same for each, so the page says nothing about which addresses exist beyond the public
// name and tenant of a company that is signing people in. A lookup that found no free database
// connection in time (security audit F5) goes to busy/route.ts, which answers 503: a page cannot
// set that status itself.
export async function loadSignInScreen(address: string, invitationId: string | null = null): Promise<SignInScreenProps> {
  await connection();
  let page;
  try {
    page = await signInPageFor(signInDirectory(), address);
  } catch (error) {
    if (!isQueueTimeout(error)) throw error;
    redirect(`/sign-in/${address}/busy`);
  }
  if (!page) notFound();
  return {
    address,
    companyName: page.companyName,
    tenantId: page.tenantId,
    invitationId,
    config: parseBrowserSignInConfig(process.env),
  };
}
