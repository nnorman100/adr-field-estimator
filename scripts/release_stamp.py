"""Identify the source of a release: the commit it was built from, or an explicit dirty mark.

Backend and Hosting releases carry the same stamp so the deployed pair can be compared and
recorded in RELEASES.md.
"""

import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMIT_PATTERN = r'[0-9a-f]{40}(?:-dirty)?'


class DirtyTree(RuntimeError):
    pass


def source_commit(paths, allow_dirty=False, git=subprocess.run):
    """Return HEAD when nothing under paths differs from it.

    Uncommitted or untracked changes would ship without being in HEAD, so they are refused unless
    allow_dirty, which stamps '<HEAD>-dirty' instead of claiming the release is HEAD.
    """

    def output(*argv):
        return git(['git', *argv], cwd=ROOT, capture_output=True, text=True, check=True).stdout

    head = output('rev-parse', 'HEAD').strip()
    if not re.fullmatch(r'[0-9a-f]{40}', head):
        raise RuntimeError('git rev-parse HEAD did not return a full commit hash.')
    changes = output('status', '--porcelain', '--untracked-files=all', '--', *paths).rstrip()
    if not changes:
        return head
    if not allow_dirty:
        raise DirtyTree(
            f'uncommitted changes under {", ".join(paths)} are not in {head[:12]}:\n{changes}'
        )
    return head + '-dirty'


def release_row(backend='—', frontend='—', commit='unknown', traffic='', notes=''):
    """One RELEASES.md log row; the operator fills any REVISION or VERSION placeholder."""
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    return f'| {today} | {backend} | {frontend} | `{commit}` | {traffic} | {notes} |'
