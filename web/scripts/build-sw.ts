// Makes the field worker (S6-2): copies sw/sw.js to public/sw.js with this build's id and the list
// of files the field shell needs, read from the build that `next build` just wrote. Runs after it
// (the `build` script):
//
//   tsx scripts/build-sw.ts
//
// The list is the shell page, the build files the page names (its own tags and the chunks its
// client components list) and the files its head links to (the manifest and icons), plus the
// manifest's icons. A hashed file the shell loads later and the list lacks would fail to load with
// no signal, so tests/e2e/offline/shell-worker.spec.ts loads the shell in both browsers and fails on
// any request the worker could not answer, and the check below fails the build when a file the
// page itself names is missing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHELL_PATH = '/field';

// Every /_next/static/... file named inside a text (the shell's HTML, a client-reference manifest).
// A script marked noModule is Next's polyfill for browsers without module scripts, which no browser
// this app supports (iPhones from iOS 16.4) ever loads, so it is left out.
export function builtFilesIn(text: string): string[] {
  const modern = text.replace(/<script\b[^>]*\snoModule[^>]*>/g, '');
  return [...new Set(modern.match(/\/_next\/static\/[A-Za-z0-9_./-]+/g) ?? [])];
}

// Same-origin files the shell's head links to or its manifest lists, outside /_next.
export function linkedFilesIn(html: string, manifest: { icons?: { src: string }[] }): string[] {
  const linked = [...html.matchAll(/<link[^>]*\shref="(\/[^"]*)"/g)].map((match) => match[1]!);
  const icons = (manifest.icons ?? []).map((icon) => icon.src);
  return [...new Set([...linked, ...icons])].filter((path) => path.startsWith('/') && !path.startsWith('/_next/'));
}

// The sorted list of paths the worker keeps. `files` is what the build gives: the shell's HTML, the
// route's client-reference manifest text and the web app manifest.
export function precacheList({
  html,
  referenceManifest,
  manifest,
}: {
  html: string;
  referenceManifest: string;
  manifest: { icons?: { src: string }[] };
}): string[] {
  const built = [...builtFilesIn(html), ...builtFilesIn(referenceManifest)];
  return [...new Set([SHELL_PATH, ...built, ...linkedFilesIn(html, manifest)])].sort();
}

// Paths the page loaded that the list does not hold. A non-empty answer fails the build and the tests.
export function missingFromPrecache(loaded: string[], list: string[]): string[] {
  const kept = new Set(list);
  return [...new Set(loaded)].filter((path) => !kept.has(path)).sort();
}

export function makeWorker({ template, buildId, list }: { template: string; buildId: string; list: string[] }): string {
  if (!template.includes("'__BUILD_ID__'") || !template.includes('__PRECACHE__')) {
    throw new Error('sw/sw.js has lost its placeholders');
  }
  return template.replace("'__BUILD_ID__'", JSON.stringify(buildId)).replace('__PRECACHE__', JSON.stringify(list));
}

function main(): void {
  const web = fileURLToPath(new URL('..', import.meta.url));
  const next = join(web, '.next');
  const read = (path: string) => readFileSync(join(next, path), 'utf8');
  const buildId = read('BUILD_ID').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(buildId)) throw new Error('unexpected build id');
  const html = read('server/app/field.html');
  const list = precacheList({
    html,
    referenceManifest: read('server/app/field/page_client-reference-manifest.js'),
    manifest: JSON.parse(read('server/app/manifest.webmanifest.body')),
  });
  // Every file in the list must exist, in the build or in public/.
  const absent = list.filter((path) => {
    if (path === SHELL_PATH) return false;
    if (path === '/manifest.webmanifest') return false;
    const file = path.startsWith('/_next/static/') ? join(next, path.slice('/_next/'.length)) : join(web, 'public', path);
    return !existsSync(file);
  });
  if (absent.length > 0) throw new Error(`the shell names files that do not exist: ${absent.join(', ')}`);
  // Every file the page names itself must be in the list.
  const named = [...builtFilesIn(html), ...linkedFilesIn(html, JSON.parse(read('server/app/manifest.webmanifest.body')))];
  const missing = missingFromPrecache(named, list);
  if (missing.length > 0) throw new Error(`the precache list misses: ${missing.join(', ')}`);
  mkdirSync(join(web, 'public'), { recursive: true });
  const template = readFileSync(join(web, 'sw', 'sw.js'), 'utf8');
  writeFileSync(join(web, 'public', 'sw.js'), makeWorker({ template, buildId, list }));
  console.log(`build-sw: ds-field-${buildId}, ${list.length} files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
