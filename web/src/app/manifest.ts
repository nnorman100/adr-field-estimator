import type { MetadataRoute } from 'next';

// The installed app (S6-2). It opens the field shell, which the service worker serves from its own
// precache, so the Home Screen icon opens with no signal.
//
// `id` stays "/" as in the old app's manifest, so a phone that installed the old app and meets
// this one at the same address (S8's choice) updates that install instead of starting a second
// one. The icons are the ones the old app already ships.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'DryScope',
    short_name: 'DryScope',
    description: 'Walk a water or mold loss once and leave with a priced, signable estimate.',
    start_url: '/field',
    scope: '/',
    display: 'standalone',
    background_color: '#F6F8FA',
    theme_color: '#0B2545',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
