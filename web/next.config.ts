import type { NextConfig } from 'next';

// The repo root has its own package-lock.json; pin the app root so Next does not guess.
const root = import.meta.dirname;

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
