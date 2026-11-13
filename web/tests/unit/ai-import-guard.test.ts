import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// One AI boundary (S7-1, docs/plans/S7.md section 3): no code outside web/src/lib/ai/ and the Live
// relay imports the Gen AI SDK or the Model Armor client, so every model call takes the boundary's
// eleven steps. The relay entry is web/src/relay/ (S7-11 builds it); if it lands elsewhere, that pull
// request moves this one path and says so.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ALLOWED = ['web/src/lib/ai/', 'web/src/relay/'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'test-results',
  'playwright-report',
  '.venv',
  '__pycache__',
  'out',
]);
const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"`](@google\/genai|@google-cloud\/modelarmor)(?:\/[^'"`]*)?['"`]/;

function importsAiSdk(source: string): boolean {
  return IMPORT.test(source);
}

function codeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) codeFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && CODE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe('AI SDK import guard', () => {
  it('finds no Gen AI SDK or Model Armor import outside the boundary and the relay', () => {
    const files = codeFiles(REPO);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .map((file) => relative(REPO, file).split(sep).join('/'))
      .filter((path) => !ALLOWED.some((root) => path.startsWith(root)))
      .filter((path) => importsAiSdk(readFileSync(join(REPO, path), 'utf8')));
    expect(offenders, 'Call models through web/src/lib/ai/ (call.ts), not the SDK directly.').toEqual([]);
  });

  it('sees the boundary itself, so the scan is really reading web/src/lib/ai/', () => {
    const inside = codeFiles(join(REPO, 'web/src/lib/ai')).filter((file) => importsAiSdk(readFileSync(file, 'utf8')));
    expect(inside.length).toBeGreaterThan(0);
  });

  it('recognises every import form, subpaths included, and nothing else', () => {
    // Built at run time, so this file's own text holds no import of either package.
    const genai = ['@google', 'genai'].join('/');
    const armor = ['@google-cloud', 'modelarmor'].join('/');
    for (const source of [
      `import { GoogleGenAI } from '${genai}';`,
      `import {GoogleGenAI} from "${genai}/node";`,
      `import type { Content } from '${genai}';`,
      `export { GoogleGenAI } from '${genai}';`,
      `import '${armor}';`,
      `const { v1 } = require('${armor}');`,
      `const m = await import('${genai}');`,
      `const m = await import(\`${armor}\`);`,
    ]) {
      expect(importsAiSdk(source), source).toBe(true);
    }
    for (const source of [
      "import { z } from 'zod';",
      "import { createAiBoundary } from '@/lib/ai/call';",
      `const name = 'the ${genai} package';`,
      `import { x } from '${genai}-extra';`,
      `import { y } from '${armor}-legacy';`,
    ]) {
      expect(importsAiSdk(source), source).toBe(false);
    }
  });
});
