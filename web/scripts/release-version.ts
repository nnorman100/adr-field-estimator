// Release version numbering for the test release (docs/plans/TC.md, TC-8). A release is named
// YYYY.MM.DD-N: the UTC date of the build and N, one more than the highest tag already pushed for
// that date. The old app's deploy.yml used the same scheme in this repository, so its tags count too.
// The release workflow's build job runs it; a rerun of a commit reads the version baked into the
// image it already pushed instead of numbering again. The record job asks it whether an existing
// GitHub Release is complete, and for the previous published DryScope test release, whose manifest
// holds the rollback target when a rerun finds this release's image already serving (none: this is
// the first recorded release).
//
//   git tag --list | node web/scripts/release-version.ts next --date <YYYY.MM.DD>
//   crane config <image> | node web/scripts/release-version.ts from-image
//   gh api --paginate --slurp repos/<repo>/releases | node web/scripts/release-version.ts previous --before <version>
//     (every page of the list; prints the tag, or nothing when there is no earlier one)
//   gh release view <version> --json isDraft,isPrerelease,assets,body \
//     | node web/scripts/release-version.ts complete --manifest <its manifest.json>   (exit 0 if complete)
//
// Plain Node with type stripping; no installed packages. It prints the version alone.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const VERSION = /^(\d{4}\.\d{2}\.\d{2})-([1-9]\d{0,5})$/;
/** The Release notes of the first recorded release, which has no rollback target. */
export const FIRST_RELEASE = 'First recorded release: there is no earlier DryScope release to return to.';
const DATE = /^\d{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value);
}

/** The next version for a date, after every same-day tag (old app or new) in tags. */
export function nextVersion(date: string, tags: Iterable<string>): string {
  if (!DATE.test(date)) throw new Error('the date must be YYYY.MM.DD');
  let highest = 0;
  for (const tag of tags) {
    const match = VERSION.exec(tag.trim());
    if (match && match[1] === date) highest = Math.max(highest, Number(match[2]));
  }
  return `${date}-${highest + 1}`;
}

function order(version: string): [string, number] {
  const match = VERSION.exec(version)!;
  return [match[1]!, Number(match[2])];
}

/**
 * The newest published DryScope test release (a non-draft pre-release tagged YYYY.MM.DD-N) before
 * version, from the GitHub releases list, or null when there is none. Whether it carries a usable
 * manifest.json is the caller's to check: a release without one is still the previous release.
 */
export function previousRelease(version: string, releases: unknown): string | null {
  if (!isVersion(version)) throw new Error('--before must be a release version');
  if (!Array.isArray(releases)) throw new Error('the releases list is not a list');
  const [date, n] = order(version);
  let best: { tag: string; date: string; n: number } | null = null;
  for (const release of releases) {
    const r = (release ?? {}) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    if (r.draft !== false || r.prerelease !== true || !isVersion(r.tag_name)) continue;
    const [d, m] = order(r.tag_name);
    if (d > date || (d === date && m >= n)) continue;
    if (!best || d > best.date || (d === best.date && m > best.n)) best = { tag: r.tag_name, date: d, n: m };
  }
  return best?.tag ?? null;
}

/**
 * Whether an existing GitHub Release (gh release view --json isDraft,isPrerelease,assets,body) is
 * complete: published, a pre-release, with manifest.json and, in its notes, the rollback note of
 * that manifest (its rollback command, or FIRST_RELEASE when it has none).
 */
export function releaseComplete(release: unknown, rollbackNote: string): boolean {
  const r = (release ?? {}) as { isDraft?: unknown; isPrerelease?: unknown; assets?: unknown; body?: unknown };
  const assets = Array.isArray(r.assets) ? r.assets : [];
  return (
    r.isDraft === false &&
    r.isPrerelease === true &&
    assets.some((asset) => (asset as { name?: unknown } | null)?.name === 'manifest.json') &&
    rollbackNote.length > 0 &&
    typeof r.body === 'string' &&
    r.body.includes(rollbackNote)
  );
}

/** The APP_VERSION an image's config carries (crane config output), or an error if it has none. */
export function versionFromImageConfig(config: unknown): string {
  const env = (config as { config?: { Env?: unknown } } | null)?.config?.Env;
  const pairs = Array.isArray(env) ? env.filter((pair) => typeof pair === 'string') : [];
  const found = pairs.filter((pair) => pair.startsWith('APP_VERSION=')).map((pair) => pair.slice(12));
  if (found.length !== 1 || !isVersion(found[0])) {
    throw new Error('the image carries no valid APP_VERSION (it was built before release versions)');
  }
  return found[0];
}

async function main(argv: string[]) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (argv[0] === 'next') {
    const i = argv.indexOf('--date');
    const date = i >= 0 ? argv[i + 1] : undefined;
    if (!date) throw new Error('--date is required');
    console.log(nextVersion(date, input.split('\n')));
  } else if (argv[0] === 'from-image') {
    console.log(versionFromImageConfig(JSON.parse(input)));
  } else if (argv[0] === 'previous') {
    const i = argv.indexOf('--before');
    const pages: unknown = JSON.parse(input);
    if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
      throw new Error('the releases pages are not lists (gh api --paginate --slurp)');
    }
    const tag = previousRelease(i >= 0 ? (argv[i + 1] ?? '') : '', pages.flat());
    if (tag) console.log(tag);
  } else if (argv[0] === 'complete') {
    const i = argv.indexOf('--manifest');
    if (i < 0 || !argv[i + 1]) throw new Error('--manifest is required');
    const manifest = JSON.parse(readFileSync(argv[i + 1]!, 'utf8')) as { rollback?: { command?: unknown } | null };
    const note =
      manifest.rollback === null
        ? FIRST_RELEASE
        : typeof manifest.rollback?.command === 'string'
          ? manifest.rollback.command
          : '';
    process.exitCode = releaseComplete(JSON.parse(input), note) ? 0 : 1;
  } else {
    throw new Error('mode must be next, from-image, previous or complete');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'release version failed');
    process.exit(1);
  });
}
