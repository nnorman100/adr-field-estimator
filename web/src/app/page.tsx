import { Button } from '@/components/ui/button';

// Placeholder only: product screens arrive in later stages.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">DryScope</h1>
      <p className="text-center text-sm">App skeleton. No product screens yet.</p>
      <Button asChild variant="outline">
        <a href="/api/health">Health check</a>
      </Button>
    </main>
  );
}
