import type { NextConfig } from 'next';

// The repo root has its own package-lock.json; pin the app root so Next does not guess.
const root = import.meta.dirname;

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root },
  outputFileTracingRoot: root,
  async headers() {
    return [
      // The field worker (S6-2). A browser that kept an old copy of it could never learn of a new
      // build, so it is never stored.
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Type', value: 'text/javascript; charset=utf-8' },
        ],
      },
      // The shell page is data-free but changes with each build, so a browser asks again each
      // time; the worker, not the HTTP cache, is what makes it open with no signal.
      { source: '/field', headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }] },
    ];
  },
};

export default nextConfig;
