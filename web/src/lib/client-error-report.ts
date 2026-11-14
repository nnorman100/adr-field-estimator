// What a browser or phone error report is, and the rules that keep personal data out of it (TC plan
// decision C13, option A). Shared by the browser (src/lib/client-errors.ts builds a report) and the
// server (src/lib/client-error-intake.ts applies the same rules again to what arrives), so the two
// sides cannot drift: nothing here touches `window`, `process` or any import.
//
// A report holds only:
//   - the error NAME, scrubbed, if it is still an identifier;
//   - the MESSAGE, scrubbed and cut to 300 characters;
//   - stack FRAMES from the app's own scripts (/_next/static/...): the function name, scrubbed, and
//     the line and column, with the fixed name app.js in place of the script's path; a frame from
//     another script is dropped, and no path or page address is ever written;
//   - the route PATTERN of the page (/sign-in/[address]), never the address itself;
//   - the browser FAMILY, one word.
// Nothing about the person, company, job or address (hard rule 6).

export type BrowserFamily = 'chrome' | 'safari' | 'firefox' | 'edge' | 'other';

export type ClientErrorReport = {
  name: string;
  message: string;
  stack: string[];
  route: string;
  browser: BrowserFamily;
};

export const BROWSER_FAMILIES = ['chrome', 'safari', 'firefox', 'edge', 'other'] as const;

export const MAX_MESSAGE = 300;
export const MAX_FRAMES = 12;

// The pages of the app, as route patterns (a route group such as (auth) is not part of the address).
// tests/unit/client-error-report.test.ts checks this covers every screen in tests/e2e/screens.ts.
export const CLIENT_ROUTES: readonly string[] = [
  '/',
  '/field',
  '/sign-in/[address]',
  '/sign-in/[address]/company',
  '/sign-in/[address]/team',
  '/sign-in/[address]/invitations/[invitationId]',
  '/sign-in/[address]/jobs/[jobId]/finish',
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

// The scrub is an allowlist, not a list of what personal data looks like: after percent-decoding,
// every run of digits becomes #, anything with an @ becomes [email], and any run of 20 or more token
// characters (or a bearer value) becomes [token], so a phone number, a coordinate, a house number, an
// id, an email or a key cannot come through whatever its shape. A URL's query string goes too.
const MAX_INPUT = 4 * MAX_MESSAGE;
const MAX_DECODES = 4;

function decoded(text: string): string {
  let out = text;
  for (let i = 0; i < MAX_DECODES && /%[0-9A-Fa-f]{2}/.test(out); i++) {
    let next: string;
    try {
      next = decodeURIComponent(out);
    } catch {
      next = out.replace(/%[0-9A-Fa-f]{2}/g, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16)));
    }
    if (next === out) break;
    out = next;
  }
  return out;
}

function scrubText(text: string): string {
  const bounded = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT).replace(/\S*$/, '') : text;
  return decoded(bounded)
    .replace(/\?\S+/g, '')
    .replace(/\S*(?:@|%40)\S*/gi, '[email]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [token]')
    .replace(/[A-Za-z0-9+/=_-]{20,}/g, '[token]')
    .replace(/\d+/g, '#');
}

export function scrubMessage(text: string): string {
  return scrubText(typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function errorName(name: unknown): string {
  const clean = typeof name === 'string' ? scrubText(name) : '';
  return NAME.test(clean) ? clean : 'Error';
}

const PATH = String.raw`\/_next\/static\/[\w\-./%~@[\]]{1,150}`;
// Written in place of every script path: the path itself is never kept.
const APP_SCRIPT = 'app.js';
const FUNCTION_NAME = /^[\w$.<>[\] #]{1,80}$/;
// A frame as found in a browser's stack text: V8 "at fn (url:line:col)", Safari and Firefox
// "fn@url:line:col". Only a frame in one of the app's own scripts is found; the query a script URL
// may carry (?dpl=...) is skipped.
const FRAME = new RegExp(`${PATH}?\\.js(?:[?#][^\\s:)]*)?:(\\d{1,7}):(\\d{1,7})`);
// The one shape a stored frame has, V8-style, which is what Error Reporting reads for JavaScript.
const CANONICAL = /^ {4}at (?:([\w$.<>[\] #]{1,80}) \(app\.js:(\d{1,7}):(\d{1,7})\)|app\.js:(\d{1,7}):(\d{1,7}))$/;

// The canonical frame: the function name scrubbed, and the line and column.
function canonicalFrame(fn: string, line: string, column: string): string {
  const name = scrubText(fn);
  const where = `${APP_SCRIPT}:${line}:${column}`;
  return FUNCTION_NAME.test(name) ? `    at ${name} (${where})` : `    at ${where}`;
}

function frameOf(line: string): string | null {
  const found = FRAME.exec(line);
  if (!found) return null;
  const head = line.slice(0, found.index).replace(/https?:\/\/[^\s/()@]*$/, '');
  const fn = head.replace(/^\s*at\s+/, '').replace(/[\s@(]+$/, '').trim();
  return canonicalFrame(fn, found[1]!, found[2]!);
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

// The server's check of frames that arrive: only the canonical shape passes, and the same rules
// apply to it again.
export function cleanFrames(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const found = CANONICAL.exec(line);
    if (found) out.push(canonicalFrame(found[1] ?? '', (found[2] ?? found[4])!, (found[3] ?? found[5])!));
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
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
// object that happens to carry a token or an email contributes nothing. `fallbackName` names what
// was thrown when it is not an Error (an unhandled rejection of a plain value, say).
export function buildReport(
  thrown: unknown,
  where: { pathname: string; userAgent: string },
  fallbackName = 'Error',
): ClientErrorReport {
  let name = fallbackName;
  let message = '';
  let stack: string[] = [];
  if (errorLike(thrown)) {
    name = errorName(thrown.name);
    message = scrubMessage(thrown.message);
    stack = ownFrames(thrown.stack);
  } else if (typeof thrown === 'string') {
    message = scrubMessage(thrown);
  }
  return { name, message, stack, route: routePattern(where.pathname), browser: browserFamily(where.userAgent) };
}
