import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { parseBrowserSignInConfig } from '@/lib/config';
import { signInPageFor } from '@/lib/sign-in';
import { signInDirectory } from '@/lib/sign-in/services';
import type { SignInScreenProps } from './sign-in-screen';

// What a company sign-in page renders with, read on the server for every request. An unknown,
// inactive or malformed address shows "This sign-in link is not recognised" (not-found.tsx) with a
// 404, the same for each, so the page says nothing about which addresses exist beyond the public
// name and tenant of a company that is signing people in.
export async function loadSignInScreen(address: string, invitationId: string | null = null): Promise<SignInScreenProps> {
  await connection();
  const page = await signInPageFor(signInDirectory(), address);
  if (!page) notFound();
  return {
    address,
    companyName: page.companyName,
    tenantId: page.tenantId,
    invitationId,
    config: parseBrowserSignInConfig(process.env),
  };
}
