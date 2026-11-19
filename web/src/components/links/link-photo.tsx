'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

// What opening a photo gives: its local blob address, null when it could not be read, or the words
// to show for a failure the page knows more about (no connection).
export type PhotoLoad = string | { message: string } | null;

// One photo of a link's photo log (S5a-11b), opened on request: each image is a request against the
// link's per-minute limit, so none is fetched until asked for. The image is a local blob address of
// the stored bytes, owned by the row from the moment it arrives and released when the row goes away.
export function LinkPhoto({ label, load }: { label: string; load: () => Promise<PhotoLoad> }) {
  const [state, setState] = useState<
    { name: 'closed' } | { name: 'loading' } | { name: 'shown'; address: string } | { name: 'failed'; message: string | null }
  >({ name: 'closed' });
  const mounted = useRef(true);
  const owned = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (owned.current) URL.revokeObjectURL(owned.current);
      owned.current = null;
    };
  }, []);

  async function open() {
    setState({ name: 'loading' });
    const loaded = await load();
    if (typeof loaded === 'string') {
      if (!mounted.current) {
        URL.revokeObjectURL(loaded);
        return;
      }
      owned.current = loaded;
      setState({ name: 'shown', address: loaded });
      return;
    }
    if (mounted.current) setState({ name: 'failed', message: loaded?.message ?? null });
  }

  if (state.name === 'shown') {
    // eslint-disable-next-line @next/next/no-img-element -- a local blob address of the stored photo bytes
    return <img src={state.address} alt={label} className="max-h-80 w-full rounded-md border bg-white object-contain" />;
  }
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="outline" disabled={state.name === 'loading'} onClick={() => void open()}>
        {state.name === 'loading' ? 'Opening the photo…' : `Show ${label.toLowerCase()}`}
      </Button>
      {state.name === 'failed' ? (
        <p role="alert" className="text-sm">
          {state.message ?? 'The photo could not be opened. Try again in a minute.'}
        </p>
      ) : null}
    </div>
  );
}
