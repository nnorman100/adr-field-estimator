import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builtFilesIn, linkedFilesIn, makeWorker, missingFromPrecache, precacheList } from '../../scripts/build-sw';

// The worker's file list (S6-2) is made from the build's own output, so these tests feed it a small
// build of the shape Next writes and check what comes out.
const HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/_next/static/chunks/a.css"/>
<link rel="preload" as="script" href="/_next/static/chunks/b.js"/>
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="icon" href="/icon.svg" type="image/svg+xml"/>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
<script src="/_next/static/chunks/poly.js" noModule=""></script>
</head><body><script src="/_next/static/chunks/c.js" async=""></script>
<script>self.__next_f.push([1,"\\"/_next/static/chunks/d.js\\""])</script></body></html>`;
const REFERENCES = 'x["/field/page"]={"chunks":["/_next/static/chunks/e.js","/_next/static/chunks/c.js"]}';
const MANIFEST = { icons: [{ src: '/icon-192.png' }, { src: '/icon.svg' }] };

describe('the shell file list', () => {
  it('holds the shell, the build files the page and its client components name, and its linked files', () => {
    expect(precacheList({ html: HTML, referenceManifest: REFERENCES, manifest: MANIFEST })).toEqual([
      '/_next/static/chunks/a.css',
      '/_next/static/chunks/b.js',
      '/_next/static/chunks/c.js',
      '/_next/static/chunks/d.js',
      '/_next/static/chunks/e.js',
      '/apple-touch-icon.png',
      '/field',
      '/icon-192.png',
      '/icon.svg',
      '/manifest.webmanifest',
    ]);
  });

  it('leaves out the polyfill script of browsers without module scripts', () => {
    expect(builtFilesIn(HTML)).not.toContain('/_next/static/chunks/poly.js');
  });

  it('takes no path of the app or another origin', () => {
    const files = linkedFilesIn('<link rel="x" href="https://cdn.example/x.js"/><link rel="y" href="/_next/static/z.css"/>', {});
    expect(files).toEqual([]);
  });

  it('is empty of anything under /api and of any person-shaped path', () => {
    const list = precacheList({ html: HTML, referenceManifest: REFERENCES, manifest: MANIFEST });
    expect(list.filter((path) => path.startsWith('/api/') || path.startsWith('/sign-in') || path.startsWith('/operator'))).toEqual([]);
  });
});

describe('a build whose list misses a file the shell loads', () => {
  const list = precacheList({ html: HTML, referenceManifest: REFERENCES, manifest: MANIFEST });

  it('is reported by name', () => {
    const short = list.filter((path) => path !== '/_next/static/chunks/c.js');
    expect(missingFromPrecache(['/field', '/_next/static/chunks/c.js'], short)).toEqual(['/_next/static/chunks/c.js']);
  });

  it('is not reported when the list holds every file', () => {
    expect(missingFromPrecache(['/field', '/_next/static/chunks/c.js', '/field'], list)).toEqual([]);
  });
});

describe('the worker', () => {
  const template = readFileSync(fileURLToPath(new URL('../../sw/sw.js', import.meta.url)), 'utf8');

  it('is the template with this build’s id and list filled in, and nothing else changed', () => {
    const worker = makeWorker({ template, buildId: 'abc_123-X', list: ['/field', '/icon.svg'] });
    expect(worker).toContain('const BUILD_ID = "abc_123-X";');
    expect(worker).toContain('const PRECACHE = ["/field","/icon.svg"];');
    expect(worker.replace('"abc_123-X"', "'__BUILD_ID__'").replace('["/field","/icon.svg"]', '__PRECACHE__')).toBe(template);
  });

  it('refuses a template that has lost a placeholder', () => {
    expect(() => makeWorker({ template: template.replace('__PRECACHE__', '[]'), buildId: 'x', list: [] })).toThrow();
  });
});
