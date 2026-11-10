"""Release automation helpers for command execution and version selection."""

import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from scripts.release_stamp import valid_version

ROOT = Path(__file__).resolve().parents[1]

# What the legacy app (alert-disaster-field-estimator on Cloud Run and hosting:alert-disaster) is
# built, released and verified from. The automatic release ships only when a merge changed one of
# these; DryScope rebuild merges (web/, infra/, docs, tests, workflows) never release it. When in
# doubt a file belongs here: an extra release is cheap, a missed one leaves production stale.
LEGACY_PREFIXES = (
    'backend/',  # Cloud Run source, Dockerfile and requirements
    'public/',  # Hosting content
)
LEGACY_FILES = (
    'index.html',  # root copy of public/index.html
    'firebase.json',
    '.firebaserc',
    'firestore.rules',
    'firestore.indexes.json',
    'package.json',  # Hosting verification (Playwright) runs from the root install
    'package-lock.json',
    # The release itself: stage, stamp, deploy, verify.
    'scripts/auto_deploy.py',
    'scripts/auto_deploy_helpers.py',
    'scripts/deploy_backend.py',
    'scripts/release_stamp.py',
    'scripts/stamp_hosting.py',
    'scripts/ensure_firestore_ttls.py',
    'scripts/verify_common.py',
    'scripts/verify_hosting.js',
    'scripts/verify_fetch.js',
    'scripts/run_python.js',
    'scripts/ci_python_version.py',
)


def is_legacy_input(name):
    """True for a repository path the legacy app's release is built from."""
    return name in LEGACY_FILES or name.startswith(LEGACY_PREFIXES)


def legacy_skip_reason(names, serving_commit, commit):
    """Why a release is skipped when none of the changed files feeds the legacy app, else None."""
    if any(is_legacy_input(name) for name in names):
        return None
    return (
        f'No file the legacy app is built from changed between the serving {serving_commit[:12]} '
        f'and {commit[:12]} ({len(names)} changed), so this DryScope rebuild merge does not '
        'release the legacy app.'
    )


class Refused(RuntimeError):
    """The release cannot proceed safely; nothing was promoted by this refusal."""


class Skipped(RuntimeError):
    """Nothing to release; not a failure."""


class Runner:
    """The only place that touches the outside world, so tests can replace it."""

    def __init__(self, root=ROOT, sleep=time.sleep):
        self.root = root
        self.sleep = sleep
        self.gcloud = shutil.which('gcloud') or 'gcloud'

    def run(self, argv, capture=True, check=True):
        result = subprocess.run(argv, cwd=self.root, capture_output=capture, text=True)
        if check and result.returncode:
            detail = (result.stderr or '').strip()[-2000:] if capture else ''
            raise Refused(f'{" ".join(argv[:4])} failed with exit {result.returncode}. {detail}')
        return result

    def fetch(self, url, method='GET', body=None, headers=None, timeout=30):
        request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read().decode('utf8', 'replace')
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode('utf8', 'replace')
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return 0, str(error)


class Record:
    """The facts a RELEASES.md row holds, written to the Actions job summary as they are learned."""

    def __init__(self, path=None):
        self.path = path
        self.facts = {}
        self.log = []

    def note(self, line):
        print(line, flush=True)
        self.log.append(line)
        self.append(f'- {line}\n')

    def set(self, key, value):
        self.facts[key] = value

    def append(self, text):
        if self.path:
            with open(self.path, 'a', encoding='utf8') as handle:
                handle.write(text)

    def table(self, outcome):
        rows = [('Outcome', outcome), *self.facts.items()]
        return '\n### Release record\n\n| Fact | Value |\n| --- | --- |\n' + ''.join(
            f'| {key} | {value} |\n' for key, value in rows
        )


def git(runner, *args, check=True):
    return runner.run(['git', *args], check=check)


def version_tags_at(runner, commit):
    result = git(runner, 'tag', '--points-at', commit, check=False)
    if result.returncode != 0:
        return []
    tags = [
        line.strip() for line in (result.stdout or '').splitlines() if valid_version(line.strip())
    ]
    return sorted(tags, key=lambda item: (item.split('-', 1)[0], int(item.split('-', 1)[1])))


def next_version(runner, commit, today=None):
    """Return the existing YYYY.MM.DD-N tag on commit, or the next UTC version for today."""
    existing = version_tags_at(runner, commit)
    if existing:
        return existing[-1]
    day = today or datetime.now(timezone.utc).strftime('%Y.%m.%d')
    prefix = day + '-'
    result = git(runner, 'tag', '--list', prefix + '*', check=False)
    numbers = []
    for line in (result.stdout or '').splitlines():
        tag = line.strip()
        if tag.startswith(prefix) and valid_version(tag):
            numbers.append(int(tag.split('-', 1)[1]))
    return f'{prefix}{max(numbers, default=0) + 1}'


def plain_commit_line(subject):
    """Format one squash-merge subject as a plain-English release note bullet."""
    subject = subject.strip()
    cleaned = re.sub(r'^[a-z]+(?:\([^)]+\))?!?:\s*', '', subject)
    if cleaned:
        cleaned = cleaned[0].upper() + cleaned[1:]
    return f'- {cleaned or subject}'


def previous_version(runner, commit):
    """The nearest earlier version tag, so the notes cover everything since that release."""
    result = git(
        runner,
        'describe',
        '--tags',
        '--abbrev=0',
        '--match',
        '[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]-*',
        f'{commit}^',
        check=False,
    )
    return (result.stdout or '').strip() if result.returncode == 0 else ''


def release_notes(runner, commit):
    """Build plain-word release notes listing the merged PRs in this release."""
    log_args = ['log', '--first-parent', '--pretty=format:%s']
    previous = previous_version(runner, commit)
    if previous:
        log_args.append(f'{previous}..{commit}')
    else:
        log_args.extend(['-n', '1', commit])
    result = git(runner, *log_args, check=False)
    bullets = [
        plain_commit_line(subject)
        for subject in (result.stdout or '').splitlines()
        if subject.strip()
    ]
    if not bullets:
        bullets.append(f'- Release commit {commit[:12]}.')
    return 'Changes in this release:\n\n' + '\n'.join(bullets)
