"""The automatic release only ships the legacy app when files it is built from changed.

DryScope rebuild merges (web/, infra/, docs, tests, workflows) must exit cleanly with a logged
reason instead of releasing alert-disaster-field-estimator and hosting:alert-disaster.
"""

import subprocess
from pathlib import Path

import pytest

from scripts import auto_deploy as auto
from scripts import auto_deploy_helpers as helpers
from scripts import stamp_hosting
from tests.test_auto_deploy import FakeRunner, release, summary  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]

REBUILD_ONLY = [
    'web/src/app/page.tsx',
    'web/migrations/0002_identity.sql',
    'infra/dryscope/main.tf',
    'docs/STATUS.md',
    'tests/test_backend.py',
    '.github/workflows/ci.yml',
    '.github/workflows/deploy.yml',
    'RELEASES.md',
    'AGENTS.md',
    'ops/monitoring/alerts.tf',
    'scripts/test-guard.mjs',
    'scripts/pricing_oracle.py',
    'backend-notes.md',
    'public-readme.md',
]

LEGACY_INPUTS = [
    'backend/main.py',
    'backend/Dockerfile',
    'backend/requirements.txt',
    'backend/static/anything.json',
    'public/app.js',
    'public/vendor/lib.js',
    'index.html',
    'firebase.json',
    '.firebaserc',
    'firestore.rules',
    'firestore.indexes.json',
    'package.json',
    'package-lock.json',
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
]


def released(runner):
    return 'stage' in runner.keys() and 'hosting-deploy' in runner.keys()


@pytest.mark.parametrize('name', REBUILD_ONLY)
def test_a_rebuild_only_merge_does_not_release_the_legacy_app(summary, name):
    runner = FakeRunner(changed=[name])
    assert release(runner) == 0
    assert not {'ttl', 'stage', 'traffic', 'stamp', 'hosting-deploy', 'verify'} & set(runner.keys())
    text = summary.text()
    assert 'skipped' in text
    assert 'legacy app' in text and 'DryScope rebuild' in text


def test_the_skip_reason_is_logged_to_the_job_output(summary, capsys):
    assert release(FakeRunner(changed=['web/src/a.ts', 'docs/STATUS.md'])) == 0
    assert 'file the legacy app is built from changed' in capsys.readouterr().out


def test_a_merge_with_no_changed_files_is_skipped(summary):
    runner = FakeRunner(changed=[])
    assert release(runner) == 0
    assert 'stage' not in runner.keys() and 'skipped' in summary.text()


@pytest.mark.parametrize('name', LEGACY_INPUTS)
def test_any_legacy_input_still_releases(summary, name):
    runner = FakeRunner(changed=['web/src/a.ts', 'docs/STATUS.md', name])
    if name in auto.HAND_RELEASED:
        assert release(runner) == 1
        assert 'stage' not in runner.keys()
    else:
        assert release(runner) == 0
        assert released(runner)


@pytest.mark.parametrize('name', ['firestore.rules', 'firestore.indexes.json'])
def test_the_hand_release_check_still_wins_over_the_skip(summary, name):
    runner = FakeRunner(changed=['web/src/a.ts', name])
    assert release(runner) == 1
    assert 'stage' not in runner.keys()
    assert name in summary.text() and 'by hand' in summary.text()


def test_the_changes_since_the_serving_commit_decide_not_only_the_last_merge(summary):
    # The diff is serving..candidate, so a legacy change merged earlier and still unreleased counts.
    runner = FakeRunner(changed=['backend/main.py', 'web/src/a.ts'])
    assert release(runner) == 0 and released(runner)


def test_a_skipped_release_runs_no_firebase_command(summary):
    runner = FakeRunner(changed=['web/src/a.ts'])
    assert release(runner) == 0
    assert not any(argv[0] == 'npx' for _, argv in runner.calls if argv)


def test_check_only_still_runs_every_refusal_check_on_a_rebuild_only_diff(summary):
    runner = FakeRunner(changed=['web/src/a.ts'])
    assert release(runner, '--check-only') == 0
    assert 'ttl' in runner.keys()
    assert not {'stage', 'traffic', 'hosting-deploy'} & set(runner.keys())
    assert 'Check only' in summary.text()


def test_diff_is_taken_without_rename_detection():
    # A file moved out of backend/ must still show its old path.
    runner = FakeRunner(changed=['web/src/a.ts'])
    release(runner)
    diff = next(argv for key, argv in runner.calls if argv[:2] == ['git', 'diff'])
    assert '--no-renames' in diff and '--name-only' in diff


def test_prefix_matching_is_exact_on_directory_boundaries():
    assert helpers.is_legacy_input('backend/x.py') and helpers.is_legacy_input('public/sw.js')
    for name in ('backend', 'backends/x.py', 'public-notes/x', 'web/public/x.js', 'web/backend/x'):
        assert not helpers.is_legacy_input(name), name


def test_every_listed_legacy_file_exists_and_every_prefix_is_a_directory():
    tracked = set(
        subprocess.run(
            ['git', 'ls-files'], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.split()
    )
    for name in helpers.LEGACY_FILES:
        assert name in tracked, f'{name} is listed as a legacy input but is not tracked'
    for prefix in helpers.LEGACY_PREFIXES:
        assert prefix.endswith('/') and any(item.startswith(prefix) for item in tracked), prefix


def test_everything_the_release_reads_is_a_legacy_input():
    # What stamp_hosting deploys, what deploy_backend uploads, and what the release scripts import.
    for name in stamp_hosting.DEPLOYED:
        assert helpers.is_legacy_input(name) or helpers.is_legacy_input(name + '/x'), name
    assert helpers.is_legacy_input('backend/anything')
    for name in (
        'scripts/auto_deploy.py',
        'scripts/auto_deploy_helpers.py',
        'scripts/deploy_backend.py',
        'scripts/release_stamp.py',
        'scripts/stamp_hosting.py',
        'scripts/ensure_firestore_ttls.py',
        'scripts/verify_common.py',
    ):
        assert helpers.is_legacy_input(name), name
    for name in auto.HAND_RELEASED:
        assert helpers.is_legacy_input(name), name
