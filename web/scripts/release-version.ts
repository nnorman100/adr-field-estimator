// Release version numbering for the test release (docs/plans/TC.md, TC-8). A release is named
// YYYY.MM.DD-N: the UTC date of the build and N, one more than the highest tag already pushed for
// that date. The old app's deploy.yml used the same scheme in this repository, so its tags count too.
// The release workflow's build job runs it; a rerun of a commit reads the version baked into the
// image it already pushed instead of numbering again.
//
//   git tag --list | node web/scripts/release-version.ts next --date <YYYY.MM.DD>
//   crane config <image> | node web/scripts/release-version.ts from-image
//
// Plain Node with type stripping; no installed packages. It prints the version alone.
import { pathToFileURL } from 'node:url';

export const VERSION = /^(\d{4}\.\d{2}\.\d{2})-([1-9]\d{0,5})$/;
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
  } else {
    throw new Error('mode must be next or from-image');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'release version failed');
    process.exit(1);
  });
}
