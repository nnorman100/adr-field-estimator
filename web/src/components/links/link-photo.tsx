'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

// One photo of a link's photo log (S5a-11b), opened on request: each image is a request against the
// link's per-minute limit, so none is fetched until asked for. The image is a local blob address of
// the stored bytes, released when the row goes away.
export function LinkPhoto({ label, load }: { label: string; load: () => Promise<string | null> }) {
  const [state, setState] = useState<{ name: 'closed' } | { name: 'loading' } | { name: 'shown'; address: string } | { name: 'failed' }>({ name: 'closed' });

  useEffect(() => {
    return () => {
      if (state.name === 'shown') URL.revokeObjectURL(state.address);
    };
  }, [state]);

  async function open() {
    setState({ name: 'loading' });
    const address = await load();
    setState(address ? { name: 'shown', address } : { name: 'failed' });
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
          The photo could not be opened. Try again in a minute.
        </p>
      ) : null}
    </div>
  );
}
