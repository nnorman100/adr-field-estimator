'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { rememberedSignInAddress } from '@/lib/sign-in/remember';

// Opening the app goes straight to the company sign-in page this phone last used (owner decision
// D5). With none remembered, the start page stays and asks for the company's link.
export function RememberedSignIn() {
  const router = useRouter();
  useEffect(() => {
    const address = rememberedSignInAddress();
    if (address) router.replace(`/sign-in/${address}`);
  }, [router]);
  return null;
}
