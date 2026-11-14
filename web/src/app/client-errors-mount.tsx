'use client';

import { useEffect } from 'react';
import { installClientErrors } from '@/lib/client-errors';

// Starts the browser and phone error reports (src/lib/client-errors.ts) once for the whole app.
// Mounted from the root layout; it draws nothing.
export function ClientErrors() {
  useEffect(() => installClientErrors(), []);
  return null;
}
