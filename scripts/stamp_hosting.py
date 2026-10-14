"""Stamp the source commit into the Hosting shell before `firebase deploy --only hosting:alert-disaster`.

The committed shell carries the placeholder marker 'unstamped'. Stamping replaces the service-worker
VERSION, every versioned asset URL and the Account menu's app version with the commit, so each
release gets a new worker cache and the deployed site can be compared with the backend's
source_commit. Restore the placeholder with --reset after deploying. firebase.json runs --check
before every Hosting deploy so an unstamped shell, which would keep serving stale cached assets, or a
shell stamped with a commit other than HEAD or with Hosting changes not in that commit, is never
released; a <commit>-dirty stamp declares such changes and is accepted as is.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.release_stamp import COMMIT_PATTERN, DirtyTree, release_row, source_commit

PLACEHOLDER = 'unstamped'
# Hosting serves public/ under the routing in firebase.json; the root index.html mirrors the shell.
DEPLOYED = ['public', 'firebase.json', '.firebaserc', 'index.html']
WORKER = re.compile(r"(?<=^const VERSION=')[^']*(?=';)", re.M)
ASSET = re.compile(r'(?:(?<=\.css\?v=)|(?<=\.js\?v=))[0-9A-Za-z-]+')
DISPLAY = re.compile(r'(?<=App version )[^<]+(?=</small>)')
# file: (pattern, exact number of matches, value for the match)
TARGETS = {
    'public/sw.js': [(WORKER, 1, 'marker')],
    'public/index.html': [(ASSET, 5, 'marker'), (DISPLAY, 1, 'display')],
    'index.html': [(ASSET, 5, 'marker'), (DISPLAY, 1, 'display')],
    'public/app.js': [(ASSET, 1, 'marker')],
    'public/sign.html': [(ASSET, 4, 'marker')],
}


def display(marker):
    """The Account menu has room for a short commit; the dirty mark stays visible."""
    if re.fullmatch(COMMIT_PATTERN, marker):
        return marker[:12] + ('-dirty' if marker.endswith('-dirty') else '')
    return marker


def stamp(text, rules, marker):
    values = {'marker': marker, 'display': display(marker)}
    for pattern, count, kind in rules:
        text, replaced = pattern.subn(values[kind], text)
        if replaced != count:
            raise RuntimeError(
                f'Expected {count} {pattern.pattern!r} markers, found {replaced}; update TARGETS.'
            )
    return text


def markers(text, rules):
    return [value for pattern, _, _ in rules for value in pattern.findall(text)]


def write(marker, root=ROOT):
    for name, rules in TARGETS.items():
        path = root / name
        text = path.read_bytes().decode('utf8')  # keeps line endings byte-for-byte
        updated = stamp(text, rules, marker)
        if updated != text:
            path.write_bytes(updated.encode('utf8'))


def check(root=ROOT, git=subprocess.run):
    """Return the stamped marker, refusing a placeholder or a shell whose files disagree. A commit
    marker must also be HEAD, with the Hosting files equal to HEAD apart from the stamp itself."""
    texts, found = {}, {}
    for name, rules in TARGETS.items():
        texts[name] = (root / name).read_bytes().decode('utf8')
        stamp(texts[name], rules, PLACEHOLDER)  # validates the marker counts
        found[name] = markers(texts[name], rules)
    marker = found['public/sw.js'][0]
    if not re.fullmatch(COMMIT_PATTERN, marker):
        raise RuntimeError(
            f'The Hosting shell is not stamped (marker {marker!r}). Run python scripts/stamp_hosting.py first.'
        )
    for name, values in found.items():
        if any(value not in (marker, display(marker)) for value in values):
            raise RuntimeError(f'{name} carries a marker other than {marker}; restamp the shell.')
    if (root / 'index.html').read_bytes() != (root / 'public/index.html').read_bytes():
        raise RuntimeError('index.html and public/index.html differ.')
    if marker.endswith('-dirty'):
        return marker
    current = source_commit([*DEPLOYED, *(':(exclude)' + name for name in TARGETS)], True, git)
    if current.removesuffix('-dirty') != marker:
        raise RuntimeError(
            f'The shell is stamped {marker} but HEAD is {current.removesuffix("-dirty")}; restamp the shell.'
        )

    def blob(*argv, **kwargs):
        return git(
            ['git', *argv], cwd=ROOT, capture_output=True, check=True, **kwargs
        ).stdout.strip()

    changed = [
        name
        for name, rules in TARGETS.items()
        if blob(
            'hash-object',
            '--path=' + name,
            '--stdin',
            input=stamp(texts[name], rules, PLACEHOLDER).encode('utf8'),
        )
        != blob('rev-parse', f'{marker}:{name}')
    ]
    if current != marker or changed:
        raise RuntimeError(
            f'Hosting files changed after stamping {marker}; commit them and restamp the shell.'
        )
    return marker


def main(argv=None, git=subprocess.run):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument(
        '--reset', action='store_true', help='restore the committed placeholder marker'
    )
    modes.add_argument(
        '--check', action='store_true', help='fail unless the shell is consistently stamped'
    )
    parser.add_argument(
        '--allow-dirty',
        action='store_true',
        help='stamp uncommitted Hosting changes as <commit>-dirty instead of refusing',
    )
    args = parser.parse_args(argv)
    try:
        if args.check:
            print('Hosting shell stamped with ' + check(git=git))
            return 0
        if args.reset:
            write(PLACEHOLDER)
            print('Hosting shell reset to the unstamped placeholder.')
            return 0
        commit = source_commit(DEPLOYED, args.allow_dirty, git)
        write(commit)
    except DirtyTree as error:
        print(
            f'Refusing to stamp Hosting: {error}\nCommit first (or --reset an earlier stamp), '
            'or pass --allow-dirty to mark the release dirty.',
            file=sys.stderr,
        )
        return 2
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    print(
        f'Hosting shell stamped with {commit}. Deploy with:\n'
        '  firebase deploy --only hosting:alert-disaster --project alert-disaster-field-2026\n'
        'then run python scripts/stamp_hosting.py --reset and append to RELEASES.md, replacing VERSION with the '
        'Hosting version:\n'
        + release_row(
            frontend=f'`{commit}` (Hosting version `VERSION`)', commit=commit, traffic='live'
        )
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
