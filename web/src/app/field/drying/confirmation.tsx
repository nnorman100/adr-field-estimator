'use client';

import type { ComponentProps, ReactNode } from 'react';

export function DryingConfirmation({
  titleId,
  title,
  children,
  ...props
}: ComponentProps<'dialog'> & { titleId: string; title: string; children: ReactNode }) {
  return (
    <dialog
      {...props}
      aria-labelledby={titleId}
      className="m-auto max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-md overscroll-contain rounded-2xl border border-input bg-background p-5 text-foreground backdrop:overflow-hidden backdrop:overscroll-contain backdrop:bg-black/40"
    >
      <h2 id={titleId} className="mb-3 text-xl font-semibold">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
