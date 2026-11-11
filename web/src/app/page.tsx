import { Button } from '@/components/ui/button';
import { RememberedSignIn } from './remembered-sign-in';

// The start page. A phone that has opened a company sign-in link goes straight back to it; product
// screens arrive in later stages.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6">
      <RememberedSignIn />
      <h1 className="text-2xl font-semibold">DryScope</h1>
      <p className="text-center text-base">To sign in, open your company&rsquo;s sign-in link.</p>
      <Button asChild variant="outline">
        <a href="/api/health">Health check</a>
      </Button>
    </main>
  );
}
