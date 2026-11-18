// The project's Claude Code settings hide the 16 Google Stitch skills from every session (their files
// stay in .claude/skills, so they can be turned back on), and the two slash commands describe the
// current web app in web/, not the retired app.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const STITCH = [
  'code-to-design',
  'design-md',
  'enhance-prompt',
  'extract-design-md',
  'extract-static-html',
  'generate-design',
  'manage-design-system',
  'react-components',
  'react-native',
  'react-vite-dashboard',
  'remotion',
  'shadcn-ui',
  'site-md',
  'stitch-loop',
  'taste-design',
  'upload-to-stitch',
];

const overrides =
  (JSON.parse(read('.claude/settings.json')) as { skillOverrides?: Record<string, string> })
    .skillOverrides ?? {};

test.each(STITCH)('hides the Stitch skill %s from every session', (name) => {
  expect(overrides[name]).toBe('off');
});

test('keeps the 16 Stitch skill folders on disk so they can be turned back on', () => {
  for (const name of STITCH) {
    expect(existsSync(path.join(ROOT, '.claude/skills', name, 'SKILL.md'))).toBe(true);
  }
});

test('does not hide the skills the web app still uses', () => {
  for (const name of ['dryscope-gotchas', 'modern-web-guidance', 'verify-dryscope']) {
    expect(overrides[name]).toBeUndefined();
  }
});

test('/review-slice reviews the web app in web/, not the retired app', () => {
  const text = read('.claude/commands/review-slice.md');
  expect(text).toContain('web/src/lib/jobs/access.ts');
  expect(text).toContain('web/tests/db/isolation-matrix.ts');
  for (const retired of [
    'Python',
    'public/index.html',
    'sw.js` cache and shell version',
    'Decimal',
  ]) {
    expect(text).not.toContain(retired);
  }
});

test('/new-slice writes the spec into the stage plans, not the retired specs/ folder', () => {
  const text = read('.claude/commands/new-slice.md');
  expect(text).toContain('docs/plans/');
  expect(text).toContain('docs/roadmap.md');
  expect(text).not.toContain('specs/slice-');
  expect(text).not.toContain('specs/_TEMPLATE.md');
});
