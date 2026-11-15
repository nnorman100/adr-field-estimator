import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiRoutePatterns, renderApiRoutes, writeApiRoutes } from '../../scripts/gen-api-routes';

// The App Check route list is made from the route files, not kept by hand (scripts/gen-api-routes.ts).

function apiTree(files: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'api-routes-'));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), 'export {};\n');
  }
  return dir;
}

describe('the route list generator', () => {
  it('lists each route.ts, with its [param] segments, and nothing else, sorted', () => {
    const dir = apiTree(['jobs/[jobId]/claim/route.ts', 'health/route.ts', 'jobs/route.ts', 'jobs/helper.ts', 'jobs/[jobId]/route.test.ts']);
    expect(apiRoutePatterns(dir)).toEqual(['/api/health', '/api/jobs', '/api/jobs/[jobId]/claim']);
  });

  it('picks up a new route file with no other edit', () => {
    const dir = apiTree(['health/route.ts']);
    const out = path.join(dir, 'out.generated.ts');
    writeApiRoutes(out, dir);
    expect(readFileSync(out, 'utf8')).not.toContain('/api/new-thing');
    mkdirSync(path.join(dir, 'new-thing'));
    writeFileSync(path.join(dir, 'new-thing/route.ts'), 'export {};\n');
    writeApiRoutes(out, dir);
    expect(readFileSync(out, 'utf8')).toContain('"/api/new-thing"');
  });

  it('writes a module that exports the patterns', () => {
    expect(renderApiRoutes(['/api/a', '/api/b/[id]'])).toContain('export const GENERATED_API_ROUTES');
    expect(renderApiRoutes(['/api/a', '/api/b/[id]'])).toContain('  "/api/b/[id]",\n');
  });
});
