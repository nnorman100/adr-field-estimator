import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CLIENT_EPOCH, CLIENT_EPOCH_HEADER } from '@/lib/app-version';
import { accessRuleOf, accountRoute, linkRoute, memberRoute, operatorRoute, publicRoute, requireFlag, serviceRoute, type AccessRule } from '@/lib/auth/route';

// Every route handler must be made by an access rule from src/lib/auth/route.ts. This finds every
// route file by searching src/app, so a new route with no rule fails here (and so in CI) without
// anyone editing a shared list. It loads each route module, as Next.js does, and runs every handler
// that is not public with a request that carries no sign-in, token or link: each must refuse before
// anything checks a token or reads the database.

const checked = vi.hoisted(() => ({
  verifier: {
    verify: async () => {
      throw new Error('a token was checked');
    },
    verifyNotRevoked: async () => {
      throw new Error('a token was checked');
    },
  },
}));
vi.mock('@/lib/auth/services', async (original) => ({
  ...(await original<typeof import('@/lib/auth/services')>()),
  identityServices: () => ({ verifier: checked.verifier, directory: {} }),
  operatorServices: () => ({ verifier: checked.verifier, operators: {} }),
  serverDatabase: () => {
    throw new Error('the database was read');
  },
}));
vi.mock('@/lib/auth/service-caller', async (original) => ({
  ...(await original<typeof import('@/lib/auth/service-caller')>()),
  serviceCallerServices: () => ({ caller: { email: 'scheduler@example.invalid', audienceFor: (job: string) => job }, verifier: checked.verifier }),
}));

const APP_DIR = fileURLToPath(new URL('../../src/app', import.meta.url));
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;
const ID = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;

// Every path parameter, whatever its name, as one id.
const params = () => ({ params: Promise.resolve(new Proxy({} as Record<string, string>, { get: (_target, key) => (typeof key === 'string' ? ID : undefined) })) });

// What a request with nothing in it gets from each rule, before its handler runs.
const REFUSED: Record<Exclude<AccessRule, 'public'>, { status: number; error: string }> = {
  member: { status: 401, error: 'missing_token' },
  account: { status: 401, error: 'missing_token' },
  operator: { status: 401, error: 'missing_token' },
  service: { status: 401, error: 'missing_token' },
  link: { status: 404, error: 'link_unavailable' },
};

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...routeFiles(path));
    else if (ROUTE_FILE.test(entry.name)) found.push(path);
  }
  return found.sort();
}

// The problems of one loaded route module; empty when every handler was made by a rule and every
// rule but public refused an empty request.
async function routeProblems(module: Record<string, unknown>, file = ''): Promise<string[]> {
  const problems: string[] = [];
  if ('default' in module) problems.push('default export');
  const handlers = METHODS.filter((method) => method in module);
  if (handlers.length === 0) problems.push('no handler found');
  for (const method of handlers) {
    const handler = module[method];
    const rule = accessRuleOf(handler);
    if (!rule) {
      problems.push(`${method} has no access rule`);
      continue;
    }
    if (rule === 'public') continue;
    // Only a write under /api/jobs is behind the version guard and needs an epoch to reach its access
    // rule; every other route, a GET and sign-in included, is sent none, so a stray guard there fails.
    const guarded = file.startsWith('api/jobs/') && !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const headers = guarded ? { [CLIENT_EPOCH_HEADER]: String(CLIENT_EPOCH) } : undefined;
    const answer = await (handler as Handler)(new Request(`http://localhost/api/${ID}`, { method, headers }), params());
    const body = await answer.json().catch(() => null);
    if (answer.status !== REFUSED[rule].status || body?.error !== REFUSED[rule].error || answer.headers.get('cache-control') !== 'no-store') {
      problems.push(`${method} (${rule}) answered ${answer.status} ${JSON.stringify(body)} to a request with no sign-in`);
    }
  }
  return problems;
}

// Found once, when the file is collected, so each route file gets its own test and its own time
// budget, and a failure names the route.
const ROUTE_FILES = routeFiles(APP_DIR).map((path) => ({ file: relative(APP_DIR, path), path }));

const ok = async () => Response.json({ ran: true });

describe('route access rules', () => {
  it('finds the known routes by searching src/app', async () => {
    const files = ROUTE_FILES.map(({ file }) => file);
    expect(files).toEqual(expect.arrayContaining(['api/echo/route.ts', 'api/health/route.ts', 'api/me/route.ts', 'api/sign/route.ts']));
  });

  it.each(ROUTE_FILES)('$file: every handler is made by an access rule, and every rule but public refuses a request with nothing in it', async ({ file, path }) => {
    expect(await routeProblems(await import(path), file)).toEqual([]);
  });

  it('fails a route module whose handler no rule made, or that has no handler', async () => {
    expect(await routeProblems({ GET: ok })).toEqual(['GET has no access rule']);
    expect(await routeProblems({ POST: (handler: Handler) => handler })).toEqual(['POST has no access rule']);
    expect(await routeProblems({ default: publicRoute(ok) })).toEqual(['default export', 'no handler found']);
    expect(await routeProblems({ dynamic: 'force-dynamic' })).toEqual(['no handler found']);
  });

  it('accepts handlers each rule made, with route settings beside them, and runs no handler but the public one', async () => {
    const handler = vi.fn(ok);
    const routeModule = {
      dynamic: 'force-dynamic',
      GET: publicRoute(ok),
      POST: memberRoute(handler),
      PUT: requireFlag('price_books', handler),
      PATCH: accountRoute(handler),
      DELETE: operatorRoute(handler),
      OPTIONS: linkRoute(handler),
      HEAD: serviceRoute('access-projection', handler),
    };
    expect(METHODS.map((method) => accessRuleOf(routeModule[method as keyof typeof routeModule]))).toEqual(['public', 'service', 'member', 'member', 'account', 'operator', 'link']);
    expect(await routeProblems(routeModule)).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });
});
