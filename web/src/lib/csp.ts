// F7 follow-up: observation only. The enforced fixed policy stays in security-headers.ts.
// Sources and the static/offline-shell reason for allowing inline bootstrap scripts are recorded
// in docs/security-csp.md. No report-sample: inline bootstrap data can include private values.
export const CSP_REPORT_PATH = '/api/client-errors';

export function cspReportOnly(env: {
  APP_ENV?: string;
  NODE_ENV?: string;
  FIREBASE_AUTH_DOMAIN?: string;
  GOOGLE_CLOUD_PROJECT?: string;
}): string {
  const local = env.APP_ENV === 'local';
  const development = local && env.NODE_ENV === 'development';
  // The same public hostname the sign-in config hands Firebase, read at runtime (one build is
  // promoted between environments). No scheme, path, port, whitespace or CSP syntax can enter it.
  const domain =
    env.FIREBASE_AUTH_DOMAIN ??
    (local && env.GOOGLE_CLOUD_PROJECT ? `${env.GOOGLE_CLOUD_PROJECT}.firebaseapp.com` : '');
  const authOrigin = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)
    ? ` https://${domain}`
    : '';
  const loopback = local ? ' http://localhost:* http://127.0.0.1:*' : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://apis.google.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/${development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    `connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://firebaseappcheck.googleapis.com https://www.google.com/recaptcha/${loopback}${development ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    `frame-src 'self'${authOrigin} https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/${loopback}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `report-uri ${CSP_REPORT_PATH}`,
    'report-to csp',
  ].join('; ');
}

export function addCspReportOnly(response: Response, pathname: string): void {
  // Keep photo/original/signature downloads' own default-src 'none'; sandbox policy untouched.
  if (/^\/api\/jobs\/[^/]+\/photos\/[^/]+\/?$/.test(pathname)) return;
  response.headers.set(
    'Content-Security-Policy-Report-Only',
    cspReportOnly({
      APP_ENV: process.env.APP_ENV,
      NODE_ENV: process.env.NODE_ENV,
      FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN,
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
    }),
  );
  response.headers.set('Reporting-Endpoints', `csp="${CSP_REPORT_PATH}"`);
}
