// Browser security headers for every response (F7 of the S3 security review). Imported by
// next.config.ts, so it uses no app code.
//
// The content policy is the fixed part only: no framing, no plugins, no <base> hijack. Nothing in
// it names a source Google serves, so it cannot break sign-in. The full script/connect policy is
// report-only (src/lib/csp.ts, docs/security-csp.md). X-Frame-Options repeats the
// framing ban for browsers that predate frame-ancestors.
//
// Next sets these before the route answers and then drops a route's own header of the same name.
// The photo download (src/lib/photos/http.ts) sends a stricter policy of its own, so the content
// policy rule skips that path and the route's policy is the one the browser gets.

type Header = { key: string; value: string };

export const SECURITY_HEADERS: readonly Header[] = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // One year, this host only. No includeSubDomains or preload: those are hard to take back.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];

export const CONTENT_SECURITY_POLICY: Header = {
  key: 'Content-Security-Policy',
  value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
};

export const SECURITY_HEADER_RULES: { source: string; headers: Header[] }[] = [
  { source: '/:path*', headers: [...SECURITY_HEADERS] },
  { source: '/:path((?!api/jobs/[^/]+/photos/[^/]+/?$).*)', headers: [CONTENT_SECURITY_POLICY] },
];
