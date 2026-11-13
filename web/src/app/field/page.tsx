import type { Metadata } from 'next';
import { FieldShell } from './field-shell';

export const metadata: Metadata = { title: 'DryScope field' };

// The field shell, prerendered at build time with no data in it (S6-2). Nothing here reads a
// cookie, a header or the database, so the page is the same file for every visitor and the
// service worker can keep it. It must stay that way: a page that rendered a person's data on the
// server could not open with no signal, and cached HTML must never hold one person's data.
export default function FieldPage() {
  return <FieldShell />;
}
