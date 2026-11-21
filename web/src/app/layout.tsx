import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppUpdate } from './app-update';
import { ClientErrors } from './client-errors-mount';

export const metadata: Metadata = {
  title: 'DryScope',
  description: 'Walk a water or mold loss once and leave with a priced, signable estimate.',
  // The Home Screen icon and name (the manifest, app/manifest.ts, is linked by Next itself). Older
  // iPhones read these instead of the manifest's icons.
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'DryScope', statusBarStyle: 'default' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0B2545' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <ClientErrors />
        <AppUpdate>{children}</AppUpdate>
      </body>
    </html>
  );
}
