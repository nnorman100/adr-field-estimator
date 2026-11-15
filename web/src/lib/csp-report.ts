import { z } from 'zod';
import { browserFamily, routePattern, type ClientErrorReport } from './client-error-report';

// Native browser payloads are untrusted. Read just these bounded fields, never a sample, original
// policy, referrer, source file, line or full URL. Unknown properties are stripped by Zod.
const url = z.string().max(2048);
const directive = z.string().max(64);
const legacySchema = z.object({
  'csp-report': z.object({
    'document-uri': url,
    'effective-directive': directive,
    'blocked-uri': url,
  }),
});
const modernSchema = z
  .array(
    z.object({
      type: z.literal('csp-violation'),
      body: z.object({ documentURL: url, effectiveDirective: directive, blockedURL: url }),
    }),
  )
  .min(1)
  .max(20);

const DIRECTIVES = new Set([
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'connect-src',
  'frame-src',
  'style-src',
  'style-src-elem',
  'style-src-attr',
  'img-src',
  'font-src',
  'media-src',
  'worker-src',
  'manifest-src',
  'object-src',
  'base-uri',
  'form-action',
  'frame-ancestors',
]);
const ORIGINS: Record<string, string> = {
  'https://identitytoolkit.googleapis.com': 'identity',
  'https://securetoken.googleapis.com': 'token',
  'https://firestore.googleapis.com': 'firestore',
  'https://firebaseappcheck.googleapis.com': 'appcheck',
  'https://apis.google.com': 'google-api',
  'https://www.google.com': 'google',
  'https://www.gstatic.com': 'gstatic',
  'https://recaptcha.google.com': 'recaptcha',
};

function blockedCategory(blocked: string, document: string): string {
  if (['inline', 'eval', 'data', 'blob'].includes(blocked)) return blocked;
  if (!blocked) return 'unknown';
  try {
    const target = new URL(blocked);
    if (target.protocol === 'blob:' || target.protocol === 'data:')
      return target.protocol.slice(0, -1);
    if (target.origin === new URL(document).origin) return 'self';
    return ORIGINS[target.origin] ?? 'external';
  } catch {
    return 'unknown';
  }
}

function report(
  document: string,
  effective: string,
  blocked: string,
  agent: string,
): ClientErrorReport {
  let route = 'unknown';
  try {
    route = routePattern(new URL(document).pathname);
  } catch {
    /* No URL is logged. */
  }
  return {
    name: 'CspViolation',
    message: `${DIRECTIVES.has(effective) ? effective : 'other'} ${blockedCategory(blocked, document)}`,
    stack: [],
    route,
    browser: browserFamily(agent),
  };
}

export function cspReports(body: unknown, type: string, agent: string): ClientErrorReport[] | null {
  if (type === 'application/csp-report') {
    const parsed = legacySchema.safeParse(body);
    if (!parsed.success) return null;
    const item = parsed.data['csp-report'];
    return [report(item['document-uri'], item['effective-directive'], item['blocked-uri'], agent)];
  }
  const parsed = modernSchema.safeParse(body);
  return parsed.success
    ? parsed.data.map(({ body: item }) =>
        report(item.documentURL, item.effectiveDirective, item.blockedURL, agent),
      )
    : null;
}
