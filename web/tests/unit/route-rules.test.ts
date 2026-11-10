import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every route handler must be wrapped in an access rule from src/lib/auth/route.ts, where it is
// defined. This finds every route file by searching src/app, so a new route with no rule fails
// here (and so in CI) without anyone editing a shared list.

const APP_DIR = fileURLToPath(new URL('../../src/app', import.meta.url));
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const RULES = new Set(['publicRoute', 'memberRoute', 'requireFlag']);
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;

function hasExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function ruleOf(expression: ts.Expression | undefined): string | null {
  if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return null;
  return RULES.has(expression.expression.text) ? expression.expression.text : null;
}

// The problems in one route file's source; empty when every handler declares a rule.
function routeRuleProblems(source: string, fileName = 'route.ts'): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  let handlers = 0;
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) problems.push('default export');
    else if (ts.isExportDeclaration(statement)) problems.push('re-export hides the access rule');
    else if (ts.isFunctionDeclaration(statement) && hasExport(statement)) {
      const name = statement.name?.text ?? 'default';
      if (METHODS.has(name)) {
        handlers += 1;
        problems.push(`${name} has no access rule`);
      }
    } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          problems.push('destructured export');
          continue;
        }
        const name = declaration.name.text;
        if (!METHODS.has(name)) continue;
        handlers += 1;
        if (!ruleOf(declaration.initializer)) problems.push(`${name} has no access rule`);
      }
    }
  }
  if (handlers === 0) problems.push('no handler found');
  return problems;
}

async function routeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(path)));
    else if (ROUTE_FILE.test(entry.name)) found.push(path);
  }
  return found.sort();
}

describe('route access rules', () => {
  it('finds the known routes by searching src/app', async () => {
    const files = (await routeFiles(APP_DIR)).map((path) => relative(APP_DIR, path));
    expect(files).toEqual(expect.arrayContaining(['api/echo/route.ts', 'api/health/route.ts', 'api/me/route.ts']));
  });

  it('every route file wraps every handler in an access rule', async () => {
    const problems: Record<string, string[]> = {};
    for (const path of await routeFiles(APP_DIR)) {
      const found = routeRuleProblems(await readFile(path, 'utf8'), path);
      if (found.length > 0) problems[relative(APP_DIR, path)] = found;
    }
    expect(problems).toEqual({});
  });

  it('fails a route file whose handler has no access rule', () => {
    expect(routeRuleProblems('export async function GET() { return Response.json({}); }')).toEqual([
      'GET has no access rule',
    ]);
    expect(routeRuleProblems('export const POST = async () => Response.json({});')).toEqual([
      'POST has no access rule',
    ]);
    expect(routeRuleProblems('export const GET = someOtherWrapper(() => Response.json({}));')).toEqual([
      'GET has no access rule',
    ]);
    expect(routeRuleProblems("export { GET } from './elsewhere';")).toContain('re-export hides the access rule');
    expect(routeRuleProblems('export default function handler() {}')).toContain('no handler found');
    expect(routeRuleProblems("export const dynamic = 'force-dynamic';")).toEqual(['no handler found']);
  });

  it('accepts handlers wrapped in a rule, with route settings beside them', () => {
    const source = [
      "import { memberRoute, publicRoute } from '@/lib/auth';",
      "export const dynamic = 'force-dynamic';",
      'export const GET = publicRoute(() => Response.json({}));',
      'export const POST = memberRoute((_r, identity) => Response.json({ id: identity.companyId }));',
      "export const PUT = requireFlag('price_books', (_r, identity) => Response.json({ id: identity.companyId }));",
    ].join('\n');
    expect(routeRuleProblems(source)).toEqual([]);
  });
});
