import * as React from 'react';

import { cn } from '@/lib/utils';

// A text field sized for a phone: 44 px tall, 16 px text (iOS Safari zooms into smaller text).
function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-md border border-foreground/40 bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
