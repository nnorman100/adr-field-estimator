// What a browser or phone error report is, and the rules that keep personal data out of it (TC plan
// decision C13, option A). Shared by the browser (src/lib/client-errors.ts builds a report) and the
// server (src/lib/client-error-intake.ts applies the same rules again to what arrives), so the two
// sides cannot drift: nothing here touches `window`, `process` or any import.
//
// A report holds only:
//   - the error NAME, if it is an identifier;
//   - the MESSAGE, scrubbed (emails, tokens, coordinates, long digit runs, URL query strings) and cut
//     to 300 characters;
//   - stack FRAMES from the app's own scripts (/_next/static/...) as path, line and column, never the
//     page address or another site's script;
//   - the route PATTERN of the page (/sign-in/[address]), never the address itself;
//   - the browser FAMILY, one word.
// Nothing about the person, company, job or address (hard rule 6).

export type ClientErrorKind = 'error' | 'rejection' | 'boundary';
export type BrowserFamily = 'chrome' | 'safari' | 'firefox' | 'edge' | 'other';

export type ClientErrorReport = {
  kind: ClientErrorKind;
  name: string;
  message: string;
  stack: string[];
  route: string;
  browser: BrowserFamily;
};

export const CLIENT_ERROR_KINDS = ['error', 'rejection', 'boundary'] as const;
export const BROWSER_FAMILIES = ['chrome', 'safari', 'firefox', 'edge', 'other'] as const;

export const MAX_MESSAGE = 300;
export const MAX_FRAMES = 12;

// The pages of the app, as route patterns (a route group such as (auth) is not part of the address).
// tests/unit/client-error-report.test.ts checks this covers every screen in tests/e2e/screens.ts.
export const CLIENT_ROUTES: readonly string[] = [
  '/',
  '/field',
  '/sign-in/[address]',
  '/sign-in/[address]/team',
  '/sign-in/[address]/invitations/[invitationId]',
  '/operator/[tenantId]',
  '/operator/[tenantId]/companies/[companyId]',
  '/operator/[tenantId]/companies/[companyId]/team',
];

// The pattern a path matches, or 'unknown'. A `[name]` segment stands for any one non-empty segment.
export function routePattern(pathname: string): string {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return 'unknown';
  const parts = pathname.replace(/\/+$/, '').split('/');
  for (const pattern of CLIENT_ROUTES) {
    const want = pattern.replace(/\/+$/, '').split('/');
    const same = want.length === parts.length && want.every((part, i) => (part.startsWith('[') ? parts[i]!.length > 0 : part === parts[i]));
    if (same) return pattern;
  }
  return 'unknown';
}

export function isKnownRoute(route: string): boolean {
  return route === 'unknown' || CLIENT_ROUTES.includes(route);
}

const REDACTED = '[redacted]';
// Order matters: a coordinate pair goes before the phone and digit-run rules, which would cut it in half.
const MESSAGE_RULES: RegExp[] = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/g, // email address
  /\bBearer\s+\S+/gi, // authorization value
  /\b[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, // JWT-shaped token
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // id
  /[A-Za-z0-9_\-+=]{32,}/g, // any other long unbroken token or digest
  /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g, // latitude, longitude pair
  /\+?\d[\d ().-]{7,}\d/g, // phone number or other long number group
  /-?\d{1,3}\.\d{4,}/g, // a single coordinate
  /\d{6,}/g, // any remaining long digit run
];

export function scrubMessage(text: string): string {
  // A URL's query string and fragment go first, whole: they are where tokens travel.
  let out = (typeof text === 'string' ? text : '').replace(/[?#]\S+/g, '');
  for (const rule of MESSAGE_RULES) out = out.replace(rule, REDACTED);
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function errorName(name: unknown): string {
  return typeof name === 'string' && NAME.test(name) ? name : 'Error';
}

const PATH = String.raw`\/_next\/static\/[\w\-./%~@[\]]{1,150}`;
const FUNCTION_NAME = /^[\w$.<>[\] ]{1,80}$/;
// A frame as found in a browser's stack text: V8 "at fn (url:line:col)", Safari and Firefox
// "fn@url:line:col". The query a script URL may carry (?dpl=...) is skipped.
const FRAME = new RegExp(`(${PATH}?\\.js)(?:[?#][^\\s:)]*)?:(\\d{1,7}):(\\d{1,7})`);
// The one shape a stored frame has, V8-style, which is what Error Reporting reads for JavaScript.
const CANONICAL = new RegExp(`^ {4}at (?:[\\w$.<>[\\] ]{1,80} \\(${PATH}\\.js:\\d{1,7}:\\d{1,7}\\)|${PATH}\\.js:\\d{1,7}:\\d{1,7})$`);

function frameOf(line: string): string | null {
  const found = FRAME.exec(line);
  if (!found) return null;
  const head = line.slice(0, found.index).replace(/https?:\/\/[^\s/()@]*$/, '');
  const fn = head.replace(/^\s*at\s+/, '').replace(/[\s@(]+$/, '').trim();
  const where = `${found[1]}:${found[2]}:${found[3]}`;
  return FUNCTION_NAME.test(fn) ? `    at ${fn} (${where})` : `    at ${where}`;
}

// The app's own frames from a stack text, rewritten into the canonical shape. The header line (which
// holds the message) and every frame from another script are dropped.
export function ownFrames(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  const out: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = frameOf(line);
    if (frame) out.push(frame);
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

// The server's check of frames that arrive: only the canonical shape passes.
export function cleanFrames(lines: readonly string[]): string[] {
  return lines.filter((line) => CANONICAL.test(line)).slice(0, MAX_FRAMES);
}

// One word. Edge and the iPhone Chrome both carry "Chrome" or "Safari" too, so the order matters.
export function browserFamily(userAgent: unknown): BrowserFamily {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return 'edge';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|\bCriOS\//.test(ua)) return 'chrome';
  if (/\bSafari\//.test(ua)) return 'safari';
  return 'other';
}

function errorLike(value: unknown): value is { name?: unknown; message: string; stack?: unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string';
}

// A report from whatever was thrown or rejected. Only the fields above are read from it, so an
// object that happens to carry a token or an email contributes nothing.
export function buildReport(
  kind: ClientErrorKind,
  thrown: unknown,
  where: { pathname: string; userAgent: string },
): ClientErrorReport {
  const fallback = kind === 'rejection' ? 'UnhandledRejection' : 'Error';
  let name = fallback;
  let message = '';
  let stack: string[] = [];
  if (errorLike(thrown)) {
    name = errorName(thrown.name);
    message = scrubMessage(thrown.message);
    stack = ownFrames(thrown.stack);
  } else if (typeof thrown === 'string') {
    message = scrubMessage(thrown);
  }
  return { kind, name, message, stack, route: routePattern(where.pathname), browser: browserFamily(where.userAgent) };
}
