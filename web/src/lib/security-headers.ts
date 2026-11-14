// Browser security headers for every response (F7 of the S3 security review). Imported by
// next.config.ts, so it uses no app code and reads only the build environment it is given.
//
// Two policies are sent:
//   - ENFORCED (Content-Security-Policy): no framing, no plugins, no <base> hijack, forms post only
//     to this site. Nothing here depends on what Google serves, so it cannot break sign-in.
//   - REPORT-ONLY (Content-Security-Policy-Report-Only): the full policy of what the app loads. It
//     is report-only because a few sources are not in any Firebase or Google documentation and can
//     only be proved on a real phone against the real project (see the list in docs/ARCHITECTURE.md
//     "Browser security headers"). Flip CSP_MODE to 'enforce' once a test-environment run, with
//     Google sign-in, the authenticator-app step, offline reconnect and (later) App Check, shows no
//     violation in the browser console.
// `frame-ancestors` is ignored in a report-only policy, which is why the framing ban is enforced
// separately (with X-Frame-Options for browsers that predate it).

export const CSP_MODE: 'report-only' | 'enforce' = 'report-only';

type Env = Record<string, string | undefined>;

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;

// Sources the browser app talks to, from the Firebase and Google documentation:
//   connect-src: identitytoolkit.googleapis.com (Auth sign-in, tenants, second step),
//     securetoken.googleapis.com (token refresh), firestore.googleapis.com (the field database),
//     firebaseappcheck.googleapis.com (App Check token exchange), www.google.com/recaptcha/
//     (reCAPTCHA and reCAPTCHA Enterprise; developers.google.com/recaptcha/docs/faq).
//   script-src: apis.google.com (Google sign-in script), www.google.com/recaptcha/ and
//     www.gstatic.com/recaptcha/ (reCAPTCHA; same FAQ).
//   frame-src: *.firebaseapp.com (the sign-in helper page on the project's auth domain),
//     accounts.google.com (Google sign-in), www.google.com/recaptcha/ and
//     recaptcha.google.com/recaptcha/ (reCAPTCHA challenge frames; same FAQ).
// Cloud Storage is not listed: the browser never talks to it (photos go through this server).
const GOOGLE_SCRIPT = ['https://apis.google.com', 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'];
const GOOGLE_CONNECT = [
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://firestore.googleapis.com',
  'https://firebaseappcheck.googleapis.com',
  'https://www.google.com/recaptcha/',
];
const GOOGLE_FRAME = [
  'https://*.firebaseapp.com',
  'https://accounts.google.com',
  'https://www.google.com/recaptcha/',
  'https://recaptcha.google.com/recaptcha/',
];

// The Auth and Firestore emulators, for the browser tests only: APP_ENV=local and a loopback
// host:port, as the Firebase CLI writes it. Anything else adds nothing.
function emulatorSources(env: Env, hosts: (string | undefined)[]): string[] {
  if (env.APP_ENV !== 'local') return [];
  return hosts
    .filter((host): host is string => host !== undefined && LOOPBACK_HOST.test(host))
    .map((host) => `http://${host}`);
}

export function enforcedPolicy(): string {
  return ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
}

export function fullPolicy(env: Env): string {
  // Next.js starts each page with inline scripts, and React and Tailwind set inline styles, so
  // 'unsafe-inline' stays until pages carry a per-request nonce (a separate, larger change). The
  // policy still stops script from any other site, and any connection to one: that is the point
  // while a script-injection bug is only hypothetical. A development server also needs eval.
  const dev = env.NODE_ENV !== 'production';
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...GOOGLE_SCRIPT]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", ...GOOGLE_CONNECT, ...emulatorSources(env, [env.FIREBASE_AUTH_EMULATOR_HOST, env.FIRESTORE_EMULATOR_HOST])]],
    // The Auth SDK opens its helper frame as soon as a page signs in, from the emulator in tests.
    ['frame-src', ["'self'", ...GOOGLE_FRAME, ...emulatorSources(env, [env.FIREBASE_AUTH_EMULATOR_HOST])]],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

export function securityHeaders(env: Env): { key: string; value: string }[] {
  return [
    // Both modes send one header of each name (a repeated key in one rule would overwrite).
    ...(CSP_MODE === 'enforce'
      ? [{ key: 'Content-Security-Policy', value: `${fullPolicy(env)}; frame-ancestors 'none'` }]
      : [
          { key: 'Content-Security-Policy', value: enforcedPolicy() },
          { key: 'Content-Security-Policy-Report-Only', value: fullPolicy(env) },
        ]),
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // One year, this host only. No includeSubDomains or preload: those are hard to take back.
    { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  ];
}
