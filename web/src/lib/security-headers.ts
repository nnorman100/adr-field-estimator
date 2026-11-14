// Browser security headers for every response (F7 of the S3 security review). Imported by
// next.config.ts, so it uses no app code.
//
// The content policy is the fixed part only: no framing, no plugins, no <base> hijack. Nothing in
// it names a source Google serves, so it cannot break sign-in. A full script and connect policy is
// a follow-up (docs/ARCHITECTURE.md, "Browser security headers"). X-Frame-Options repeats the
// framing ban for browsers that predate frame-ancestors.

const CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // One year, this host only. No includeSubDomains or preload: those are hard to take back.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];
